import crypto from 'crypto';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---------------------------------------------------------------------------
// Tuning. These are the levers you'll actually want to move.
// ---------------------------------------------------------------------------

export const INVITER_BONUS = 5000;   // chips to the person who invited
export const INVITEE_BONUS = 1000;   // chips to the person who joined

// A referral pays out only after the invitee proves they're a real player.
// Both conditions must hold.
const MIN_HANDS_PLAYED = 20;
const MIN_ACCOUNT_AGE_HOURS = 24;

// Lifetime ceiling per inviter. Without this, one determined person with a
// script mints unlimited chips.
const MAX_QUALIFIED_REFERRALS = 20;

// Salt for hashing IPs and device fingerprints. Set this in your environment
// and never change it, or existing hashes stop matching.
const HASH_SALT = process.env.REFERRAL_HASH_SALT || 'change-me-in-env';

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
const CODE_LENGTH = 7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hashIdentifier(value) {
  if (!value) return null;
  return crypto
    .createHash('sha256')
    .update(HASH_SALT + ':' + String(value).trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function normalizeCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * Credits chips exactly once for a given idem_key.
 *
 * Returns true if chips moved, false if this event was already applied.
 * Must be called inside a transaction.
 */
export async function creditChips(client, userId, delta, reason, idemKey) {
  const inserted = await client.query(
    `insert into chip_ledger (user_id, delta, reason, idem_key)
     values ($1, $2, $3, $4)
     on conflict (idem_key) do nothing
     returning id`,
    [userId, delta, reason, idemKey]
  );

  if (inserted.rowCount === 0) return false; // replay — already paid

  await client.query(
    `update users set chips = chips + $1 where id = $2`,
    [delta, userId]
  );

  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns this player's permanent referral code, creating it on first call.
 */
export async function getOrCreateCode(userId) {
  const existing = await pool.query(
    `select code from referral_codes where user_id = $1`,
    [userId]
  );
  if (existing.rowCount > 0) return existing.rows[0].code;

  // Retry on the astronomically unlikely collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const result = await pool.query(
      `insert into referral_codes (user_id, code)
       values ($1, $2)
       on conflict do nothing
       returning code`,
      [userId, code]
    );
    if (result.rowCount > 0) return result.rows[0].code;

    // conflict could be on user_id (someone raced us) — re-read
    const reread = await pool.query(
      `select code from referral_codes where user_id = $1`,
      [userId]
    );
    if (reread.rowCount > 0) return reread.rows[0].code;
  }

  throw new Error('Could not generate a referral code');
}

/**
 * Records that `inviteeId` signed up using `rawCode`. Pays nothing yet —
 * the referral sits pending until the invitee qualifies.
 *
 * Call this once, right after account creation.
 */
export async function applyCode(inviteeId, rawCode, { ip, deviceId } = {}) {
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) {
    return { ok: false, error: 'invalid_code' };
  }

  const client = await pool.connect();
  try {
    await client.query('begin');

    const owner = await client.query(
      `select user_id from referral_codes where code = $1`,
      [code]
    );
    if (owner.rowCount === 0) {
      await client.query('rollback');
      return { ok: false, error: 'unknown_code' };
    }

    const inviterId = owner.rows[0].user_id;
    if (inviterId === inviteeId) {
      await client.query('rollback');
      return { ok: false, error: 'self_referral' };
    }

    const ipHash = hashIdentifier(ip);
    const deviceHash = hashIdentifier(deviceId);

    const inserted = await client.query(
      `insert into referrals
         (inviter_id, invitee_id, code, signup_ip_hash, device_hash)
       values ($1, $2, $3, $4, $5)
       on conflict (invitee_id) do nothing
       returning id`,
      [inviterId, inviteeId, code, ipHash, deviceHash]
    );

    if (inserted.rowCount === 0) {
      await client.query('rollback');
      return { ok: false, error: 'already_referred' };
    }

    await client.query('commit');
    return { ok: true, status: 'pending' };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Checks whether a pending referral for this invitee has earned out, and pays
 * both sides if so.
 *
 * Call this after every hand the invitee finishes. It's cheap and idempotent —
 * once the referral is qualified or rejected it returns immediately.
 */
export async function qualifyReferral(inviteeId) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    // Lock the referral row so two concurrent hand-completions can't both pay.
    const ref = await client.query(
      `select id, inviter_id, invitee_id, signup_ip_hash, device_hash
         from referrals
        where invitee_id = $1 and status = 'pending'
        for update`,
      [inviteeId]
    );

    if (ref.rowCount === 0) {
      await client.query('commit');
      return { ok: true, status: 'nothing_pending' };
    }

    const r = ref.rows[0];

    // --- Is the invitee a real player yet? ---
    const invitee = await client.query(
      `select hands_played,
              extract(epoch from (now() - created_at)) / 3600 as age_hours
         from users where id = $1`,
      [inviteeId]
    );

    const { hands_played: hands, age_hours: ageHours } = invitee.rows[0];

    if (hands < MIN_HANDS_PLAYED || ageHours < MIN_ACCOUNT_AGE_HOURS) {
      await client.query('commit');
      return {
        ok: true,
        status: 'pending',
        handsRemaining: Math.max(0, MIN_HANDS_PLAYED - hands),
      };
    }

    // --- Abuse checks, run only at payout time ---
    const reject = async (reason) => {
      await client.query(
        `update referrals set status = 'rejected', reject_reason = $2 where id = $1`,
        [r.id, reason]
      );
      await client.query('commit');
      return { ok: false, status: 'rejected', reason };
    };

    const qualifiedCount = await client.query(
      `select count(*)::int as n from referrals
        where inviter_id = $1 and status = 'qualified'`,
      [r.inviter_id]
    );
    if (qualifiedCount.rows[0].n >= MAX_QUALIFIED_REFERRALS) {
      return await reject('inviter_cap_reached');
    }

    // Same device as any other account this inviter referred, or as the
    // inviter themselves — that's one person with two logins.
    if (r.device_hash) {
      const dupeDevice = await client.query(
        `select 1 from referrals
          where device_hash = $1 and invitee_id <> $2
          limit 1`,
        [r.device_hash, inviteeId]
      );
      if (dupeDevice.rowCount > 0) return await reject('duplicate_device');
    }

    // Several signups from one IP is normal (households, campus wifi).
    // Several signups from one IP all pointing at the same inviter is not.
    if (r.signup_ip_hash) {
      const sameIp = await client.query(
        `select count(*)::int as n from referrals
          where inviter_id = $1 and signup_ip_hash = $2 and invitee_id <> $3`,
        [r.inviter_id, r.signup_ip_hash, inviteeId]
      );
      if (sameIp.rows[0].n >= 2) return await reject('ip_clustering');
    }

    // --- Pay out ---
    await client.query(
      `update referrals set status = 'qualified', qualified_at = now() where id = $1`,
      [r.id]
    );

    await creditChips(
      client, r.inviter_id, INVITER_BONUS,
      'referral_inviter', `ref:${r.id}:inviter`
    );
    await creditChips(
      client, r.invitee_id, INVITEE_BONUS,
      'referral_invitee', `ref:${r.id}:invitee`
    );

    await client.query('commit');
    return { ok: true, status: 'qualified', awarded: INVITER_BONUS };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Everything the invite screen needs to render.
 */
export async function getReferralSummary(userId) {
  const code = await getOrCreateCode(userId);

  const stats = await pool.query(
    `select
       count(*) filter (where status = 'pending')   ::int as pending,
       count(*) filter (where status = 'qualified') ::int as qualified
     from referrals where inviter_id = $1`,
    [userId]
  );

  const { pending, qualified } = stats.rows[0];

  return {
    code,
    link: `https://lanepoker.online/join?ref=${code}`,
    pending,
    qualified,
    chipsEarned: qualified * INVITER_BONUS,
    slotsLeft: Math.max(0, MAX_QUALIFIED_REFERRALS - qualified),
    inviterBonus: INVITER_BONUS,
    inviteeBonus: INVITEE_BONUS,
    handsRequired: MIN_HANDS_PLAYED,
  };
}
