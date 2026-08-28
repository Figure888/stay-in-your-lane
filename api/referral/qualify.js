// Internal only. Prefer calling qualifyReferral() directly from wherever you
// finalize a hand on the server:
//
//   await recordHandResult(...);
//   await pool.query(
//     'update users set hands_played = hands_played + 1 where id = $1', [userId]);
//   await qualifyReferral(userId);   // cheap no-op once settled
//
// This HTTP wrapper exists only for the case where your game server is a
// separate service. Never let a client reach it.

import { qualifyReferral } from '../../lib/referrals.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing_user_id' });

  try {
    const result = await qualifyReferral(userId);
    return res.status(200).json(result);
  } catch (err) {
    console.error('referral/qualify failed', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
