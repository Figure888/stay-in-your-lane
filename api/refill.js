import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const { data, error } = await sb.rpc('claim_refill');
  if (error) return res.status(401).json({ error: 'not signed in' });
  res.status(200).json(data[0]);
}
