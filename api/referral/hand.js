// POST /api/referral/hand
// Call when a hand finishes. Increments the counter and pays out the
// referral if this hand tipped it over the line.
//
// Cheap to call every hand — it returns immediately once a referral is
// settled. Safe to call for players with no referral at all.

import { recordHand } from '../../lib/referrals.js';
import { requireUser } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  try {
    const result = await recordHand(userId);
    return res.status(200).json(result);
  } catch {
    return res.status(500).json({ error: 'server_error' });
  }
}
