// POST /api/social/moderate { targetId, action: 'mute'|'unmute'|'report', gameId?, reason? }
//
// A player can silence someone immediately rather than waiting for a
// moderator who doesn't exist yet. Reporting mutes too — nobody wants to keep
// reading it while they wait.

import { admin } from '../../lib/referrals.js';
import { requireUser } from '../../lib/auth.js';
import { limit } from '../../lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  if (!(await limit(res, userId, 'moderate', 20, 60))) return;

  const { targetId, action, gameId, reason } = req.body || {};
  if (!targetId) return res.status(400).json({ error: 'missing_target' });

  try {
    let result;

    if (action === 'report') {
      result = await admin.rpc('report_player', {
        p_user: userId, p_target: targetId,
        p_game: Number.isInteger(gameId) ? gameId : null,
        p_reason: String(reason || ''),
      });
    } else if (action === 'mute' || action === 'unmute') {
      result = await admin.rpc('mute_player', {
        p_user: userId, p_target: targetId, p_on: action === 'mute',
      });
    } else {
      return res.status(400).json({ error: 'unknown_action' });
    }

    if (result.error) throw result.error;
    return res.status(result.data.ok ? 200 : 400).json(result.data);
  } catch (err) {
    console.error('moderate failed', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
