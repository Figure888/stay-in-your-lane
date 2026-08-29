// One route for the whole social layer — chat, gifts, leaderboards, moderation.
//
// These were three separate files. Vercel's Hobby plan caps serverless
// functions per deployment, and three routes that each do one small thing
// don't need three cold starts. Same dispatch pattern as api/convoy/action.js.
//
//   GET  /api/social?do=chat&gameId=1&after=0
//   GET  /api/social?do=leaderboard&scope=global
//   POST /api/social { do:'say',      gameId, body }
//   POST /api/social { do:'gift',     gameId, gift }
//   POST /api/social { do:'location', country, region }
//   POST /api/social { do:'mute'|'unmute'|'report', targetId, gameId?, reason? }

import { admin } from '../lib/referrals.js';
import { requireUser } from '../lib/auth.js';
import { limit } from '../lib/ratelimit.js';

const SCOPES = ['global', 'national', 'local'];

export default async function handler(req, res) {
  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  const op = String((req.method === 'GET' ? req.query?.do : req.body?.do) || '');

  try {
    // ---------------------------------------------------------------- reads
    if (req.method === 'GET') {
      if (op === 'chat') {
        if (!(await limit(res, userId, 'chat:read', 90, 60))) return;

        const gameId = Number(req.query.gameId);
        if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'bad_game_id' });

        const { data, error } = await admin.rpc('chat_since', {
          p_user: userId, p_game: gameId, p_after: Number(req.query.after) || 0,
        });
        if (error) throw error;
        return res.status(data.ok ? 200 : 403).json(data);
      }

      if (op === 'leaderboard') {
        if (!(await limit(res, userId, 'leaderboard', 30, 60))) return;

        const scope = SCOPES.includes(req.query.scope) ? req.query.scope : 'global';
        const { data, error } = await admin.rpc('leaderboard',
          { p_user: userId, p_scope: scope, p_limit: 25 });
        if (error) throw error;
        return res.status(200).json(data);
      }

      return res.status(400).json({ error: 'unknown_op' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    // --------------------------------------------------------------- writes
    const { gameId, body, gift, country, region, targetId, reason } = req.body || {};

    if (op === 'say' || op === 'gift') {
      // Sending is limited harder than reading — this is the spam surface.
      if (!(await limit(res, userId, 'chat:send', 20, 60))) return;
      if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'bad_game_id' });

      const { data, error } = op === 'gift'
        ? await admin.rpc('send_gift', { p_user: userId, p_game: gameId, p_gift: String(gift || '') })
        : await admin.rpc('send_chat', { p_user: userId, p_game: gameId, p_body: String(body || '') });

      if (error) throw error;
      return res.status(data.ok ? 200 : 400).json(data);
    }

    if (op === 'location') {
      if (!(await limit(res, userId, 'location', 10, 60))) return;

      const { data, error } = await admin.rpc('set_location', {
        p_user: userId,
        p_country: country ? String(country).toUpperCase().slice(0, 2) : null,
        p_region: region ? String(region) : null,
      });
      if (error) throw error;
      return res.status(data.ok ? 200 : 400).json(data);
    }

    if (op === 'mute' || op === 'unmute' || op === 'report') {
      if (!(await limit(res, userId, 'moderate', 20, 60))) return;
      if (!targetId) return res.status(400).json({ error: 'missing_target' });

      const { data, error } = op === 'report'
        ? await admin.rpc('report_player', {
            p_user: userId, p_target: targetId,
            p_game: Number.isInteger(gameId) ? gameId : null,
            p_reason: String(reason || ''),
          })
        : await admin.rpc('mute_player', {
            p_user: userId, p_target: targetId, p_on: op === 'mute',
          });

      if (error) throw error;
      return res.status(data.ok ? 200 : 400).json(data);
    }

    return res.status(400).json({ error: 'unknown_op' });
  } catch (err) {
    console.error('social route failed', op, err);
    return res.status(500).json({ error: 'server_error' });
  }
}
