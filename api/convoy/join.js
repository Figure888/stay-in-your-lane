// POST /api/convoy/join  { stake }
// Matches you with a waiting player at that stake, or queues you.

import { joinConvoy } from '../../lib/convoy.js';
import { requireUser } from '../../lib/auth.js';

const STAKES = [100, 500, 1000, 5000];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  const stake = Number(req.body?.stake);

  // Whitelist rather than range-check: an arbitrary stake would let someone
  // sit at a table nobody else can ever join.
  if (!STAKES.includes(stake)) {
    return res.status(400).json({ error: 'bad_stake', allowed: STAKES });
  }

  try {
    const result = await joinConvoy(userId, stake);
    if (!result.ok) return res.status(400).json(result);
    return res.status(200).json(result);
  } catch {
    return res.status(500).json({ error: 'server_error' });
  }
}
