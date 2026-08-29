// GET /api/social/leaderboard?scope=global|national|local
//
// Region comes from what the player set, not from their IP. Guessing someone's
// location and then ranking them by it is a support ticket waiting to happen.

import { admin } from '../../lib/referrals.js';
import { requireUser } from '../../lib/auth.js';
import { limit } from '../../lib/ratelimit.js';

const SCOPES = ['global', 'national', 'local'];

export default async function handler(req, res) {
  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  if (!(await limit(res, userId, 'leaderboard', 30, 60))) return;

  try {
    if (req.method === 'POST') {
      const { country, region } = req.body || {};
      const { data, error } = await admin.rpc('set_location', {
        p_user: userId,
        p_country: country ? String(country).toUpperCase().slice(0, 2) : null,
        p_region: region ? String(region) : null,
      });
      if (error) throw error;
      return res.status(data.ok ? 200 : 400).json(data);
    }

    const scope = SCOPES.includes(req.query?.scope) ? req.query.scope : 'global';

    const { data, error } = await admin.rpc('leaderboard',
      { p_user: userId, p_scope: scope, p_limit: 25 });
    if (error) throw error;
    return res.status(200).json(data);
  } catch (err) {
    console.error('leaderboard failed', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
