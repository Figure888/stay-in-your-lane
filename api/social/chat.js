// GET  /api/social/chat?gameId=1&after=0   -> new messages
// POST /api/social/chat { gameId, body }   -> say something
// POST /api/social/chat { gameId, gift }   -> send a decorative gift
//
// Chat is scoped to a game: two people who chose to sit down together. A
// global lobby would be a moderation job nobody here has staff for.

import { admin } from '../../lib/referrals.js';
import { requireUser } from '../../lib/auth.js';
import { limit } from '../../lib/ratelimit.js';

export default async function handler(req, res) {
  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  try {
    if (req.method === 'GET') {
      if (!(await limit(res, userId, 'chat:read', 90, 60))) return;

      const gameId = Number(req.query?.gameId);
      const after = Number(req.query?.after) || 0;
      if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'bad_game_id' });

      const { data, error } = await admin.rpc('chat_since',
        { p_user: userId, p_game: gameId, p_after: after });
      if (error) throw error;
      return res.status(data.ok ? 200 : 403).json(data);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const { gameId, body, gift } = req.body || {};
    if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'bad_game_id' });

    // Sending is limited harder than reading — this is the spam surface.
    if (!(await limit(res, userId, 'chat:send', 20, 60))) return;

    const rpc = gift
      ? admin.rpc('send_gift', { p_user: userId, p_game: gameId, p_gift: String(gift) })
      : admin.rpc('send_chat', { p_user: userId, p_game: gameId, p_body: String(body || '') });

    const { data, error } = await rpc;
    if (error) throw error;
    return res.status(data.ok ? 200 : 400).json(data);
  } catch (err) {
    console.error('chat failed', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
