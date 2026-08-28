// Session validation against Neon's auth schema.
//
// Neon provisioned a Better Auth schema (neon_auth.user / session / account).
// Rather than adding the better-auth package as a dependency, this validates
// the session token directly against the database — you already have a
// connection, and it's one less thing to keep in sync.
//
// requireUser() returns the public.users.id for the signed-in player, or null.
// It creates the game profile row on first sight, so a player who signs up
// through Better Auth automatically gets chips and a referral code.
//
// !! The session column names below are Better Auth's defaults. Confirm them
// !! against PART 3 of setup_all.sql before trusting this. If your session
// !! table uses different names, change SESSION_TOKEN_COL / SESSION_EXPIRY_COL
// !! / SESSION_USER_COL and nothing else needs to move.

import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SESSION_TOKEN_COL  = 'token';
const SESSION_EXPIRY_COL = 'expiresAt';
const SESSION_USER_COL   = 'userId';

const COOKIE_NAMES = [
  'better-auth.session_token',
  '__Secure-better-auth.session_token',
];

const STARTING_CHIPS = 10000;

function parseCookies(header) {
  const out = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Pulls the session token from a cookie or an Authorization header.
 * Better Auth appends a signature after a dot; the stored token is the part
 * before it.
 */
function extractToken(req) {
  const cookies = parseCookies(req.headers?.cookie);

  for (const name of COOKIE_NAMES) {
    if (cookies[name]) return cookies[name].split('.')[0];
  }

  const auth = req.headers?.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim().split('.')[0];
  }

  return null;
}

/**
 * Returns the public.users.id for the signed-in player, or null.
 *
 * Creates the game profile on first call for a given auth user, so signup
 * and first-login both work without a separate hook.
 */
export async function requireUser(req) {
  const token = extractToken(req);
  if (!token) return null;

  const client = await pool.connect();
  try {
    const session = await client.query(
      `select "${SESSION_USER_COL}" as auth_user_id
         from neon_auth."session"
        where "${SESSION_TOKEN_COL}" = $1
          and "${SESSION_EXPIRY_COL}" > now()
        limit 1`,
      [token]
    );

    if (session.rowCount === 0) return null; // expired, revoked, or forged

    const authUserId = session.rows[0].auth_user_id;

    // Fast path — profile already exists.
    const existing = await client.query(
      `select id from public.users where auth_user_id = $1`,
      [authUserId]
    );
    if (existing.rowCount > 0) return existing.rows[0].id;

    // First sight of this player. Create the game profile, copying their
    // email across. ON CONFLICT handles two requests racing on first login.
    const created = await client.query(
      `insert into public.users (auth_user_id, email, chips)
       select u.id, u.email, $2
         from neon_auth."user" u
        where u.id = $1
       on conflict (auth_user_id) do nothing
       returning id`,
      [authUserId, STARTING_CHIPS]
    );

    if (created.rowCount > 0) return created.rows[0].id;

    // Lost the race — the other request created it. Read it back.
    const reread = await client.query(
      `select id from public.users where auth_user_id = $1`,
      [authUserId]
    );
    return reread.rowCount > 0 ? reread.rows[0].id : null;
  } catch (err) {
    console.error('requireUser failed', err);
    return null;
  } finally {
    client.release();
  }
}
