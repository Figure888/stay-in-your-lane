// Whop webhook — payment fulfilment.
//
// No SDK. Whop's own docs currently say to verify without one: the helper
// methods moved out of @whop/api and the replacements aren't released yet.
// Dropping the package also drops three unpatched @auth/core CVEs that were
// sitting in the payment path.
//
// Signature scheme (Standard Webhooks): HMAC-SHA256 over
// `{webhook-id}.{webhook-timestamp}.{raw body}`, base64, sent as
// `webhook-signature: v1,<sig>`.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PLAN_CHIPS = {
  [process.env.WHOP_PLAN_RACK]:  10000,
  [process.env.WHOP_PLAN_STACK]: 60000,
  [process.env.WHOP_PLAN_TRAY]:  200000,
};

const TOLERANCE_SECONDS = 300;   // Standard Webhooks default

export const config = { api: { bodyParser: false } };

/** The signature is over the exact bytes received — parsing first breaks it. */
function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verify(body, headers) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'];
  if (!id || !ts || !sigHeader) return null;

  // Reject anything outside the tolerance window. Without this, a captured
  // request replays forever with a perfectly valid signature.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return null;

  const secret = process.env.WHOP_WEBHOOK_SECRET || '';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${id}.${ts}.${body.toString('utf8')}`)
    .digest('base64');

  // The header can carry several space-delimited versioned signatures.
  const candidates = sigHeader.split(' ')
    .map((s) => s.split(',').pop())
    .filter(Boolean);

  const ok = candidates.some((c) => {
    const a = Buffer.from(c);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });

  if (!ok) return null;

  try { return JSON.parse(body.toString('utf8')); } catch { return null; }
}

async function resolveUser(data) {
  if (data?.metadata?.user_id) return data.metadata.user_id;

  const email = data?.user_email || data?.email;
  if (!email) return null;

  const { data: row } = await admin
    .from('profiles').select('id').eq('email', email).maybeSingle();
  return row?.id || null;
}

export default async function handler(req, res) {
  let event;
  try {
    event = verify(await rawBody(req), req.headers);
  } catch (err) {
    console.error('webhook read failed', err);
    return res.status(500).send('read error');   // 500 so Whop retries
  }

  if (!event) return res.status(400).send('bad signature');

  const chips = PLAN_CHIPS[event.data?.plan_id];
  const handled = ['payment.succeeded', 'refund.created', 'dispute.created'];
  if (!chips || !handled.includes(event.type)) {
    return res.status(200).json({ received: true });
  }

  const userId = await resolveUser(event.data || {});
  if (!userId) {
    // A row we can query later, not a log line nobody reads.
    await admin.from('unmatched_payments').upsert({
      id: event.id, event_type: event.type, payload: event.data,
    });
    return res.status(200).json({ received: true, unmatched: true });
  }

  const sign = event.type === 'payment.succeeded' ? 1 : -1;

  // event.id is stable across Whop's retries, so the ledger's unique idem_key
  // is the replay guard — no separate processed_events check that could fail
  // open and silently drop a paid customer's chips.
  const { data: result, error } = await admin.rpc('apply_purchase', {
    p_user: userId,
    p_delta: sign * chips,
    p_reason: event.type,
    p_idem_key: 'whop:' + event.id,
  });

  if (error) {
    console.error('apply_purchase failed', event.id, error);
    return res.status(500).send('fulfilment failed');   // Whop retries
  }

  return res.status(200).json({ received: true, status: result?.status });
}
