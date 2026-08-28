// Swap this for however you're doing sessions. It's the only file that needs
// to know about your auth provider.
//
// Supabase example:
//
//   import { createClient } from '@supabase/supabase-js';
//   const supabase = createClient(
//     process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
//
//   export async function requireUser(req) {
//     const token = (req.headers.authorization || '').replace('Bearer ', '');
//     const { data, error } = await supabase.auth.getUser(token);
//     return error ? null : data.user.id;
//   }

export async function requireUser(req) {
  throw new Error('requireUser is not implemented — wire this to your auth provider');
}
