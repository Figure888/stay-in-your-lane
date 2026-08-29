// Private tables.
//
//   POST /api/convoy/invite            -> create a code
//   POST /api/convoy/invite { code }   -> redeem one
//   GET  /api/convoy/invite?code=ABC   -> has anyone joined yet?
//
// Solves the empty-lobby problem: heads-up needs someone already waiting, and
// at launch nobody is.

import { admin } from '../../lib/referrals.js';
import { requireUser } from '../../lib/auth.js';
import { limit } from '../../lib/ratelimit.js';

const STAKES = [100, 500, 1000, 5000];

const MESSAGES = {
  insufficient_chips:   'Not enough chips for that stake.',
  host_short_on_chips:  'The host is short on chips for this table.',
  already_in_game:      "You're already at a table.",
  cannot_join_own_table:"That's your own invite.",
  invite_already_used:  'Someone else took that seat.',
  invite_expired:       'That invite has expired.',
  unknown_code:         'No table with that code.',
};

export default async function handler(req, res) {
  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  if (!(await limit(res, userId, 'convoy:invite', 10, 60))) return;

  try {
    if (req.method === 'GET') {
      const code = String(req.query?.code || '').toUpperCase();
      if (!code) return res.status(400).json({ error: 'missing_code' });

      const { data, error } = await admin.rpc('convoy_invite_status',
        { p_user: userId, p_code: code });
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const { code, stake } = req.body || {};

    // With a code, you're joining. Without one, you're opening a table.
    if (code) {
      const { data, error } = await admin.rpc('convoy_redeem_invite',
        { p_user: userId, p_code: String(code) });
      if (error) throw error;
      if (!data.ok) {
        return res.status(400).json({ ...data, message: MESSAGES[data.error] || 'Could not join.' });
      }
      return res.status(200).json(data);
    }

    const s = Number(stake);
    if (!STAKES.includes(s)) return res.status(400).json({ error: 'bad_stake', allowed: STAKES });

    const { data, error } = await admin.rpc('convoy_create_invite',
      { p_user: userId, p_stake: s });
    if (error) throw error;
    if (!data.ok) {
      return res.status(400).json({ ...data, message: MESSAGES[data.error] || 'Could not open a table.' });
    }

    return res.status(200).json({
      ...data,
      link: 'https://lanepoker.online/?table=' + data.code,
    });
  } catch (err) {
    console.error('convoy invite failed', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
