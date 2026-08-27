import { createClient } from '@supabase/supabase-js';
import { makeWebhookValidator } from '@whop/api';

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// secret must be base64-encoded — raw string fails with a useless error
const validate = makeWebhookValidator({
  webhookSecret: Buffer.from(process.env.WHOP_WEBHOOK_SECRET).toString('base64'),
});

const PLAN_CHIPS = {
  [process.env.WHOP_PLAN_RACK]:  10000,
  [process.env.WHOP_PLAN_STACK]: 60000,
  [process.env.WHOP_PLAN_TRAY]:  200000,
};

export const config = { api: { bodyParser: false } };

async function resolveUser(data) {
  const fromMeta = data?.metadata?.user_id;
  if (fromMeta) return fromMeta;

  // fallback: match on the buyer's email
  const email = data?.user_email || data?.email;
  if (!email) return null;
  const { data: row } = await admin
    .from('profiles').select('id').eq('email', email).maybeSingle();
  return row?.id || null;
}

export default async function handler(req, res) {
  let event;
  try {
    event = await validate(req);
  } catch {
    return res.status(400).send('bad signature');
  }

  const { error: dupe } = await admin
    .from('processed_events').insert({ id: event.id });
  if (dupe) return res.status(200).json({ received: true });

  const data = event.data || {};
  const chips = PLAN_CHIPS[data.plan_id];
  if (!chips) return res.status(200).json({ received: true });

  const userId = await resolveUser(data);
  if (!userId) {
    console.error('UNMATCHED PAYMENT', event.id, data.plan_id);
    return res.status(200).json({ received: true });
  }

  const sign = event.type === 'payment.succeeded' ? 1 : -1;
  if (['payment.succeeded','refund.created','dispute.created'].includes(event.type)) {
    await admin.rpc('add_chips', { user_id: userId, amount: sign * chips });
  }

  res.status(200).json({ received: true });
}
