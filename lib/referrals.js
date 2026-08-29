// Referral system — thin wrapper over the Postgres functions.
//
// All the logic lives in the database (see db/supabase_referrals.sql) so
// payouts are atomic. This file only hashes identifiers and forwards calls.
//
// Uses the same admin client pattern as api/whop-webhook.js.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Set REFERRAL_HASH_SALT in Vercel and never change it — changing it orphans
// every stored hash and the abuse checks silently stop matching.
const HASH_SALT = process.env.REFERRAL_HASH_SALT;

/** Hashes an IP or device id so the raw value is never stored. */
export function hashIdentifier(value) {
  if (!value || !HASH_SALT) return null;
  return crypto
    .createHash('sha256')
    .update(`${HASH_SALT}:${String(value).trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

function unwrap(result, label) {
  if (result.error) {
    console.error(`${label} failed`, result.error);
    throw new Error(result.error.message);
  }
  return result.data;
}

/** Everything the invite screen needs. Creates the player's code on first call. */
export async function getReferralSummary(userId) {
  return unwrap(
    await admin.rpc('referral_summary', { p_user: userId }),
    'referral_summary'
  );
}

/** Records a pending referral. Pays nothing until the invitee qualifies. */
export async function applyCode(inviteeId, code, { ip, deviceId } = {}) {
  return unwrap(
    await admin.rpc('apply_referral_code', {
      p_invitee: inviteeId,
      p_code: code,
      p_ip_hash: hashIdentifier(ip),
      p_device_hash: hashIdentifier(deviceId),
    }),
    'apply_referral_code'
  );
}

/** Counts a finished hand and pays out the referral if it now qualifies. */
export async function recordHand(userId) {
  return unwrap(
    await admin.rpc('record_hand', { p_user: userId }),
    'record_hand'
  );
}
