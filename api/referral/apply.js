// POST /api/referral/apply  { code, deviceId }
// Call once, immediately after the account is created.
// Records the referral as pending. Pays nothing yet.

import { applyCode } from '../../lib/referrals.js';
import { requireUser } from '../../lib/auth.js';

const MESSAGES = {
  invalid_code:     "That code doesn't look right. Check for typos.",
  unknown_code:     "No player has that code.",
  self_referral:    "You can't invite yourself.",
  already_referred: "You've already used an invite code.",
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const userId = await requireUser(req);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  const { code, deviceId } = req.body || {};

  // On Vercel, x-forwarded-for is set by the platform and can't be spoofed by
  // the client. If you self-host, make sure your proxy overwrites it.
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress;

  try {
    const result = await applyCode(userId, code, { ip, deviceId });

    if (!result.ok) {
      return res.status(400).json({
        error: result.error,
        message: MESSAGES[result.error] || 'That code could not be used.',
      });
    }

    return res.status(200).json({
      status: 'pending',
      message: 'Code accepted. Play 20 hands to unlock the bonus for both of you.',
    });
  } catch (err) {
    console.error('referral/apply failed', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
