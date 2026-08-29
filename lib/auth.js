// Session validation against Supabase Auth.
//
// The client sends its Supabase access token as a Bearer header; this
// verifies it and returns profiles.id. profiles.id is the same uuid as the
// Supabase auth user id, so a valid token IS the answer.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

export async function requireUser(req) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('SUPABASE_URL / SUPABASE_ANON_KEY are not set');
    return null;
  }

  const auth = req.headers?.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id || null;
  } catch (err) {
    console.error('requireUser failed', err);
    return null;
  }
}
