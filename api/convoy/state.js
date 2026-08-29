// GET /api/convoy/state?gameId=123
// The board as you're allowed to see it. Safe to poll.

import { convoyState } from '../../lib/convoy.js';
import { requireUser } from '../../lib/auth.js';
import { limit } from '../../lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  if (!(await limit(res, userId, 'convoy:state', 90, 60))) return;

  const gameId = Number(req.query?.gameId);
  if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'bad_game_id' });

  try {
    const state = await convoyState(gameId, userId);
    if (state.error) return res.status(403).json(state);
    return res.status(200).json(state);
  } catch {
    return res.status(500).json({ error: 'server_error' });
  }
}
