// One route for both online games.
//
// Was api/convoy/action.js. Lane Hold'em needs an endpoint too, and Vercel's
// Hobby plan caps serverless functions per deployment — adding a twelfth file
// breaks the build with no useful error. So both games dispatch through here.
//
//   Convoy:
//     POST { game:'convoy', do:'join',   stake }
//     POST { game:'convoy', do:'draw'|'place'|'swap'|'bet', gameId, ... }
//     GET  ?game=convoy&gameId=1
//
//   Lane Hold'em:
//     POST { game:'holdem', do:'join',  buyin }
//     POST { game:'holdem', do:'act',   tableId, action:'fold'|'call'|'raise', amount }
//     POST { game:'holdem', do:'next'|'leave', tableId }
//     GET  ?game=holdem&tableId=1

import { admin } from '../lib/referrals.js';
import { requireUser } from '../lib/auth.js';
import { limit } from '../lib/ratelimit.js';

const CONVOY_STAKES = [100, 250, 500];
const HOLDEM_BUYINS = [1000, 5000, 25000];
const BETS = ['check', 'call', 'raise', 'fold'];

function unwrap(result, label) {
  if (result.error) {
    console.error(`${label} failed`, result.error);
    throw new Error(result.error.message);
  }
  return result.data;
}

export default async function handler(req, res) {
  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  const src = req.method === 'GET' ? req.query : (req.body || {});
  const game = String(src.game || 'convoy');

  try {
    // ------------------------------------------------------------- reads
    if (req.method === 'GET') {
      if (!(await limit(res, userId, 'table:state', 90, 60))) return;

      if (game === 'holdem') {
        const tableId = Number(src.tableId);
        if (!Number.isInteger(tableId)) return res.status(400).json({ error: 'bad_table_id' });
        const state = unwrap(await admin.rpc('holdem_state',
          { p_user: userId, p_table: tableId }), 'holdem_state');
        return res.status(state.error ? 403 : 200).json(state);
      }

      const gameId = Number(src.gameId);
      if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'bad_game_id' });
      const state = unwrap(await admin.rpc('convoy_state',
        { p_game: gameId, p_user: userId }), 'convoy_state');
      return res.status(state.error ? 403 : 200).json(state);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const op = String(src.do || '');

    // ------------------------------------------------------ lane hold'em
    if (game === 'holdem') {
      if (op === 'join') {
        if (!(await limit(res, userId, 'table:join', 20, 60))) return;
        const buyin = Number(src.buyin);
        if (!HOLDEM_BUYINS.includes(buyin)) {
          return res.status(400).json({ error: 'bad_buyin', allowed: HOLDEM_BUYINS });
        }
        const d = unwrap(await admin.rpc('holdem_join',
          { p_user: userId, p_buyin: buyin }), 'holdem_join');
        return res.status(d.ok ? 200 : 400).json(d);
      }

      const tableId = Number(src.tableId);
      if (!Number.isInteger(tableId)) return res.status(400).json({ error: 'bad_table_id' });

      if (op === 'act') {
        if (!(await limit(res, userId, 'table:act', 60, 60))) return;
        const action = String(src.action || '');
        if (!BETS.includes(action)) return res.status(400).json({ error: 'bad_action' });

        const d = unwrap(await admin.rpc('holdem_act', {
          p_user: userId, p_table: tableId,
          p_action: action === 'check' ? 'call' : action,
          p_amount: action === 'raise' ? Number(src.amount) || 0 : null,
        }), 'holdem_act');

        if (!d.ok) return res.status(400).json(d);
        const state = unwrap(await admin.rpc('holdem_state',
          { p_user: userId, p_table: tableId }), 'holdem_state');
        return res.status(200).json({ ...d, state });
      }

      if (op === 'next' || op === 'leave') {
        if (!(await limit(res, userId, 'table:act', 60, 60))) return;
        const d = unwrap(await admin.rpc(op === 'next' ? 'holdem_next' : 'holdem_leave',
          { p_user: userId, p_table: tableId }), op);
        return res.status(d.ok ? 200 : 400).json(d);
      }

      return res.status(400).json({ error: 'unknown_op' });
    }

    // ------------------------------------------------------------ convoy
    if (op === 'join') {
      if (!(await limit(res, userId, 'table:join', 20, 60))) return;
      const stake = Number(src.stake);
      if (!CONVOY_STAKES.includes(stake)) {
        return res.status(400).json({ error: 'bad_stake', allowed: CONVOY_STAKES });
      }
      const d = unwrap(await admin.rpc('convoy_join',
        { p_user: userId, p_stake: stake }), 'convoy_join');
      return res.status(d.ok ? 200 : 400).json(d);
    }

    const gameId = Number(src.gameId);
    if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'bad_game_id' });

    if (!(await limit(res, userId, 'table:act', 60, 60))) return;

    let d;
    if (op === 'draw') {
      d = unwrap(await admin.rpc('convoy_draw', { p_game: gameId, p_user: userId }), 'draw');
    } else if (op === 'place') {
      const lane = Number(src.lane);
      if (!Number.isInteger(lane) || lane < 0 || lane > 3) {
        return res.status(400).json({ error: 'bad_lane' });
      }
      d = unwrap(await admin.rpc('convoy_place',
        { p_game: gameId, p_user: userId, p_lane: lane }), 'place');
    } else if (op === 'swap') {
      const slot = Number(src.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot > 4) {
        return res.status(400).json({ error: 'bad_slot' });
      }
      d = unwrap(await admin.rpc('convoy_swap',
        { p_game: gameId, p_user: userId, p_slot: slot }), 'swap');
    } else if (op === 'bet') {
      const bet = String(src.bet || '');
      if (!BETS.includes(bet)) return res.status(400).json({ error: 'bad_bet' });
      d = unwrap(await admin.rpc('convoy_bet',
        { p_game: gameId, p_user: userId, p_action: bet }), 'bet');
    } else {
      return res.status(400).json({ error: 'unknown_op' });
    }

    if (!d.ok) return res.status(400).json(d);

    const state = unwrap(await admin.rpc('convoy_state',
      { p_game: gameId, p_user: userId }), 'convoy_state');
    return res.status(200).json({ ...d, state });
  } catch (err) {
    console.error('table route failed', game, err);
    return res.status(500).json({ error: 'server_error' });
  }
}
