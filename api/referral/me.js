// GET /api/referral/me — the signed-in player's code, link, and progress.

import { getReferralSummary } from '../../lib/referrals.js';
import { requireUser } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  try {
    return res.status(200).json(await getReferralSummary(userId));
  } catch {
    return res.status(500).json({ error: 'server_error' });
  }
}
