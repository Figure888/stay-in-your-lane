// POST /api/convoy/action  { gameId, action, lane?, slot?, bet? }
//
// One route for every move, so the client has a single place to send from:
//   { action: 'draw' }
//   { action: 'place', lane: 0-3 }
//   { action: 'swap',  slot: 0-4 }
//   { action: 'bet',   bet: 'check' | 'call' | 'raise' | 'fold' }
//
// The database decides whether the move is legal. This only routes it.

import { convoyDraw, convoyPlace, convoySwap, convoyBet, convoyState }
  from '../../lib/convoy.js';
import { requireUser } from '../../lib/auth.js';
import { limit } from '../../lib/ratelimit.js';

const BETS = ['check', 'call', 'raise', 'fold'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  if (!(await limit(res, userId, 'convoy:action', 60, 60))) return;

  const { gameId, action, lane, slot, bet } = req.body || {};
  if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'bad_game_id' });

  try {
    let result;

    switch (action) {
      case 'draw':
        result = await convoyDraw(gameId, userId);
        break;

      case 'place':
        if (!Number.isInteger(lane) || lane < 0 || lane > 3) {
          return res.status(400).json({ error: 'bad_lane' });
        }
        result = await convoyPlace(gameId, userId, lane);
        break;

      case 'swap':
        if (!Number.isInteger(slot) || slot < 0 || slot > 4) {
          return res.status(400).json({ error: 'bad_slot' });
        }
        result = await convoySwap(gameId, userId, slot);
        break;

      case 'bet':
        if (!BETS.includes(bet)) return res.status(400).json({ error: 'bad_bet' });
        result = await convoyBet(gameId, userId, bet);
        break;

      default:
        return res.status(400).json({ error: 'unknown_action' });
    }

    if (!result.ok) return res.status(400).json(result);

    // Return the new board with the result, so the client doesn't need a
    // second round trip to redraw.
    const state = await convoyState(gameId, userId);
    return res.status(200).json({ ...result, state });
  } catch {
    return res.status(500).json({ error: 'server_error' });
  }
}
