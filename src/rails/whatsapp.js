// WhatsApp wrapper (REAL WhatsApp Cloud API in live mode): text, interactive buttons and media.
// Server-side guardrails the prompt cannot override:
//   - only numbers in the tenancy's Parties tab can be messaged (consent, R1/R20)
//   - no message outside the recipient's call_hours (R6), unless the recipient wrote in the last 10 min
// In local mode messages go to an outbox that tests and the demo console can read.
import { config, isLive } from '../lib/config.js';
import { kv } from '../lib/kv.js';
import { audit, maskPhone } from '../lib/audit.js';
import { nowMs } from '../lib/clock.js';
import { getLedger } from '../ledger/index.js';
import { takeScenario } from '../lib/scenario.js';
import { toolError } from '../lib/mcp.js';

const enforceHours = () => (process.env.CALL_HOURS_ENFORCE ?? 'true') !== 'false';

function inHours(callHours, ms) {
  if (!callHours) return true;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(callHours);
  if (!m) return true;
  const ist = new Date(ms + 5.5 * 3600e3);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= Number(m[1]) * 60 + Number(m[2]) && mins <= Number(m[3]) * 60 + Number(m[4]);
}

async function guard(to) {
  const parties = await (await getLedger()).read('Parties');
  const p = parties.find((x) => x.msisdn === String(to).replace(/^\+/, ''));
  if (!p) return { error: `recipient ${maskPhone(to)} is not a party of any tenancy; TenLy only messages people who consented` };
  if (enforceHours() && !inHours(p.call_hours, await nowMs())) {
    const lastIn = await kv.get(`tenly:lastin:${p.msisdn}`);
    if (!lastIn || (await nowMs()) - lastIn > 10 * 60e3) return { error: `outside ${p.name}'s call hours (${p.call_hours} IST); set next_action_at to the start of the window (R6)` };
  }
  return { party: p };
}

async function sendRaw(payload) {
  const scn = await takeScenario('wa.send');
  if (scn === 'http500') return { status: 500, body: { error: { message: 'Service temporarily unavailable', code: 2 } } };
  if (!sendsLive(payload.to)) {
    const id = `wamid.SIM${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await kv.lpushCapped('tenly:wa:outbox', { id, at: await nowMs(), live: false, ...payload }, 1000);
    return { status: 200, simulated: true, body: { messaging_product: 'whatsapp', contacts: [{ input: payload.to, wa_id: payload.to }], messages: [{ id }] } };
  }
  const r = await fetch(`${config.graphBase}/${config.waPhoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.waToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
  });
  const body = await r.json().catch(() => ({}));
  await kv.lpushCapped('tenly:wa:outbox', { id: body?.messages?.[0]?.id || '', at: await nowMs(), live: true, http: r.status, ...payload, error: body?.error?.message }, 1000);
  return { status: r.status, body };
}

// Real WhatsApp only for numbers that can receive it (WA_LIVE_NUMBERS, comma list; empty = all).
// Other parties (e.g. a simulated owner) go to the outbox, shown on the demo console.
function sendsLive(to) {
  if (!isLive() || !config.waToken || !config.waPhoneId) return false;
  const list = (process.env.WA_LIVE_NUMBERS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return !list.length || list.includes(String(to));
}

async function send(kind, to, payload, summary) {
  const g = await guard(to);
  if (g.error) {
    await audit({ actor: 'wrapper', source_connector: 'tenly_wa_ui', action: `${kind} refused`, to: maskPhone(to), result: g.error });
    return toolError({ error: g.error });
  }
  const res = await sendRaw({ to: g.party.msisdn, ...payload });
  const msgId = res.body?.messages?.[0]?.id || '';
  await audit({ actor: 'wrapper', source_connector: 'tenly_wa_ui', action: kind, to: `${g.party.role}:${g.party.name}`, message_text: summary, external_ref: msgId, result: `graph ${res.status}` });
  const out = { http_status: res.status, message_id: msgId, to_role: g.party.role, delivery: res.simulated ? 'simulated (party has no live WhatsApp in this demo)' : 'whatsapp', body: res.body };
  return res.status >= 400 ? toolError(out) : out;
}

export const waTools = [
  {
    name: 'send_text_message',
    description: 'WhatsApp Cloud API (REAL): POST /{phone-number-id}/messages type text. Only to parties of the tenancy, inside their call hours. Returns message_id.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'msisdn from the Parties tab, e.g. 919000000001' }, body: { type: 'string' } }, required: ['to', 'body'] },
    handler: (a) => send('send_text_message', a.to, { type: 'text', text: { body: a.body, preview_url: false } }, a.body),
  },
  {
    name: 'send_interactive_message',
    description: 'WhatsApp Cloud API (REAL): interactive reply buttons (max 3, title max 20 chars). Button ids come back as button_id in the next event, so name the obligation in them, e.g. "ok:OB-17", "cancel:OB-17", "notmine:OB-17", "approve:OB-17", "fixed:OB-17", "broken:OB-17".',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, buttons: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } } }, required: ['to', 'body', 'buttons'] },
    handler: async (a) => {
      if (!Array.isArray(a.buttons) || a.buttons.length < 1 || a.buttons.length > 3) return toolError({ error: 'buttons must have 1 to 3 items' });
      const bad = a.buttons.find((b) => !b.id || !b.title || b.title.length > 20);
      if (bad) return toolError({ error: `each button needs id and a title of at most 20 characters: ${JSON.stringify(bad)}` });
      return send('send_interactive_message', a.to, {
        type: 'interactive',
        interactive: { type: 'button', body: { text: a.body }, action: { buttons: a.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } },
      }, `${a.body} [${a.buttons.map((b) => b.title).join('] [')}]`);
    },
  },
  {
    name: 'send_media_message',
    description: 'WhatsApp Cloud API (REAL): send audio/image/document by link. For a Gnani voice reply use type "audio" and media_url = the audio_url returned by tenly_gnani tts.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, type: { type: 'string', enum: ['audio', 'image', 'document'] }, media_url: { type: 'string' }, caption: { type: 'string' } }, required: ['to', 'type', 'media_url'] },
    handler: (a) => send('send_media_message', a.to, { type: a.type, [a.type]: { link: a.media_url, ...(a.caption && a.type !== 'audio' ? { caption: a.caption } : {}) } }, `[${a.type}] ${a.caption || a.media_url.split('?')[0]}`),
  },
];

// Accept the field names models commonly use for WhatsApp sends.
const pick = (a, keys) => keys.map((k) => a[k]).find((v) => v != null && v !== '');
function coerceWa(a) {
  const out = { ...a };
  out.to = String(pick(a, ['to', 'phone', 'msisdn', 'recipient', 'number', 'to_msisdn']) ?? '').replace(/[^0-9]/g, '');
  const body = pick(a, ['body', 'text', 'message', 'content', 'msg', 'message_text']);
  if (body != null) out.body = typeof body === 'object' ? (body.body || body.text || JSON.stringify(body)) : String(body);
  if (Array.isArray(a.buttons)) {
    out.buttons = a.buttons.map((b, i) => (typeof b === 'string' ? { id: `${b.toLowerCase().replace(/[^a-z]+/g, '')}:${a.obligation_id || i}`, title: b } : { id: b.id || b.button_id || b.payload, title: b.title || b.text || b.label }));
  }
  return out;
}
for (const t of waTools) t.coerce = coerceWa;

export async function outbox(n = 50) { return kv.lrange('tenly:wa:outbox', n); }
