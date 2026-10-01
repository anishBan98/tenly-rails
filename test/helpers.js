// Test helpers: boot the app on a random port in local mode and speak Meta's webhook format.
import { createHmac } from 'node:crypto';

process.env.TENLY_MODE = 'local';
process.env.MOCK_TIMEOUT_MS = '300';
process.env.CALL_HOURS_ENFORCE = process.env.CALL_HOURS_ENFORCE || 'false';

const { serve } = await import('@hono/node-server');
const { app, boot } = await import('../src/app.js');

export const KEYS = { sheets: 'dev-sheets', gnani: 'dev-gnani', wa: 'dev-waui', dlv: 'dev-dlv', p3p: 'dev-p3p', caps: 'dev-caps' };
export const PARTY = { tenant: '919000000001', owner: '919000000002', tradesman: '919000000003', stranger: '919999999999' };

export async function start() {
  await boot();
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      const base = `http://127.0.0.1:${info.port}`;
      process.env.PUBLIC_BASE_URL = base;
      resolve({ base, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

export const admin = (base, path, body) => fetch(`${base}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'x-admin-key': 'dev-admin-key', 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());

let seq = 0;
export function waMessage(from, kind, value) {
  const id = `wamid.TEST${Date.now()}${++seq}`;
  const m = { from, id, timestamp: String(Math.floor(Date.now() / 1000)) };
  if (kind === 'text') Object.assign(m, { type: 'text', text: { body: value } });
  if (kind === 'audio') Object.assign(m, { type: 'audio', audio: { id: value.media_id, mime_type: 'audio/ogg; codecs=opus', voice: true } });
  if (kind === 'image') Object.assign(m, { type: 'image', image: { id: value.media_id, mime_type: 'image/jpeg', caption: value.caption || '' } });
  if (kind === 'button') Object.assign(m, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: value.id, title: value.title } } });
  return m;
}

export async function webhook(base, message, { badSig = false } = {}) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PNID' }, messages: [message] } }] }] });
  const sig = createHmac('sha256', badSig ? 'wrong' : 'dev-meta-secret').update(body).digest('hex');
  const r = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` }, body });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text(), id: message.id };
}

// Fake Pine Labs Plural (the native AgenticOrg connector in production).
export function fakePlural() {
  const orders = new Map();
  return {
    orders,
    async create_payment_link({ amount, merchant_order_reference }) {
      const order_id = `v1-plural-${merchant_order_reference}`;
      orders.set(order_id, { amount, status: 'CREATED' });
      return { order_id, url: `https://pluraluat.v2.pinepg.in/pay/${order_id}` };
    },
    async get_order_status({ order_id }) { return { order_id, status: orders.get(order_id)?.status || 'NOT_FOUND' }; },
    markPaid(order_id) { orders.get(order_id).status = 'PAID'; },
  };
}
