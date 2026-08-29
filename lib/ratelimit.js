// Rate limiting helper.
//
// Backed by Postgres — no Redis, no extra vendor. Call it at the top of a
// route, after auth, and bail if it returns false.
//
//   if (!(await limit(res, userId, 'convoy:join', 20, 60))) return;

import { admin } from './referrals.js';

/**
 * Returns true if the call may proceed. On denial it has already written a
 * 429 with Retry-After, so the caller just returns.
 *
 * Fails OPEN: if the limiter itself errors, the request goes through. A
 * broken limiter should slow you down, not take the game offline.
 */
export async function limit(res, subject, bucket, max, windowSeconds) {
  try {
    const { data, error } = await admin.rpc('check_rate_limit', {
      p_key: `${bucket}:${subject}`,
      p_limit: max,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      console.error('rate limit check failed', error);
      return true;
    }

    if (!data?.allowed) {
      res.setHeader('Retry-After', String(data.retryAfter || windowSeconds));
      res.status(429).json({
        error: 'rate_limited',
        message: 'Slow down a moment.',
        retryAfter: data.retryAfter,
      });
      return false;
    }

    return true;
  } catch (err) {
    console.error('rate limit threw', err);
    return true;
  }
}

/** For routes where the caller isn't signed in yet. */
export function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}
