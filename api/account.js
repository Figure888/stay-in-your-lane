// GET  /api/account            -> profile, stats, setup state
// POST /api/account { username } or { avatar }
//
// Avatar bytes never come through here — the client uploads straight to
// Supabase Storage under its own user folder, then posts the path.

import { admin } from '../lib/referrals.js';
import { requireUser } from '../lib/auth.js';
import { limit } from '../lib/ratelimit.js';

export default async function handler(req, res) {
  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  if (!(await limit(res, userId, 'account', 30, 60))) return;

  try {
    if (req.method === 'GET') {
      const { data, error } = await admin.rpc('get_account', { p_user: userId });
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const { username, avatar } = req.body || {};

    if (username !== undefined) {
      const { data, error } = await admin.rpc('set_username',
        { p_user: userId, p_name: String(username) });
      if (error) throw error;
      return res.status(data.ok ? 200 : 400).json(data);
    }

    if (avatar !== undefined) {
      const { data, error } = await admin.rpc('set_avatar',
        { p_user: userId, p_avatar: avatar === null ? '' : String(avatar) });
      if (error) throw error;
      return res.status(data.ok ? 200 : 400).json(data);
    }

    return res.status(400).json({ error: 'nothing_to_update' });
  } catch (err) {
    console.error('account route failed', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
