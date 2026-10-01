// WhatsApp inbound relay. Deterministic gates the agent must not be trusted with alone:
//   1. authenticity  - X-Hub-Signature-256 HMAC over the raw body (Meta app secret)
//   2. duplicates    - a message ID is processed once (Meta retries webhooks)
//   3. identity      - the sender's role comes from the Parties tab, never from message text
//   4. kill switch   - PAUSE/STOP from tenant or owner pauses the tenancy; RESUME only from the pauser
//   5. media         - voice notes/photos become short-lived signed URLs (the agent never sees tokens)
// Then either starts an AgenticOrg run (when an API key is configured) or appends the event to the
// Sheet's Inbox tab, which the every-minute sweep workflow processes.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './lib/config.js';
import { kv } from './lib/kv.js';
import { audit, maskPhone } from './lib/audit.js';
import { nowMs, toIST } from './lib/clock.js';
import { getLedger } from './ledger/index.js';
import { registerWaMedia } from './lib/media.js';

export function verifySignature(raw, header) {
  if (!header?.startsWith('sha256=')) return false;
  const want = createHmac('sha256', config.metaAppSecret).update(raw).digest('hex');
  const got = header.slice(7);
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function normalise(m) {
  const base = { event_id: m.id, from_msisdn: m.from, context_msg_id: m.context?.id || '', text: '', button_id: '', media_id: '', mime: '' };
  switch (m.type) {
    case 'text': return { ...base, message_type: 'text', text: m.text?.body || '' };
    case 'audio': return { ...base, message_type: 'audio', media_id: m.audio?.id, mime: m.audio?.mime_type || 'audio/ogg' };
    case 'image': return { ...base, message_type: 'image', media_id: m.image?.id, mime: m.image?.mime_type || 'image/jpeg', text: m.image?.caption || '' };
    case 'interactive': {
      const r = m.interactive?.button_reply || m.interactive?.list_reply || {};
      return { ...base, message_type: 'button', button_id: r.id || '', text: r.title || '' };
    }
    case 'button': return { ...base, message_type: 'button', button_id: m.button?.payload || '', text: m.button?.text || '' };
    default: return { ...base, message_type: 'unsupported', text: `[${m.type}]` };
  }
}

export async function handleMessage(m) {
  const ev = normalise(m);
  const l = await getLedger();
  // 2. duplicates
  if (!(await kv.set(`tenly:dedupe:${ev.event_id}`, 1, { ttlSec: 86400, nx: true }))) {
    await audit({ actor: 'relay', event_id: ev.event_id, action: 'dropped', result: 'duplicate message id' });
    return { status: 'duplicate' };
  }
  // 3. identity
  const party = (await l.read('Parties')).find((p) => p.msisdn === ev.from_msisdn);
  if (!party) {
    await audit({ actor: 'relay', event_id: ev.event_id, action: 'blocked', input_summary: `from ${maskPhone(ev.from_msisdn)}`, result: 'unknown sender' });
    return { status: 'unknown_sender' };
  }
  await kv.set(`tenly:lastin:${party.msisdn}`, await nowMs());
  const tenancy = (await l.read('Tenancy')).find((t) => t.tenancy_id === party.tenancy_id);
  // 4. kill switch
  const word = ev.text.trim().toUpperCase();
  const paused = tenancy?.paused === 'TRUE';
  if (['PAUSE', 'STOP'].includes(word) && ['tenant', 'owner'].includes(party.role) && !paused) {
    await l.updateWhere('Tenancy', { tenancy_id: party.tenancy_id }, { paused: 'TRUE', paused_by: party.role });
    await audit({ actor: 'relay', event_id: ev.event_id, tenancy_id: party.tenancy_id, action: 'tenancy paused', input_summary: `${party.role} sent ${word}`, rule: 'R15' });
  } else if (word === 'RESUME' && paused) {
    if (tenancy.paused_by !== party.role) {
      await audit({ actor: 'relay', event_id: ev.event_id, tenancy_id: party.tenancy_id, action: 'blocked', result: `RESUME from ${party.role}, but ${tenancy.paused_by} paused` });
      return { status: 'blocked_paused' };
    }
    await l.updateWhere('Tenancy', { tenancy_id: party.tenancy_id }, { paused: 'FALSE', paused_by: '' });
    await audit({ actor: 'relay', event_id: ev.event_id, tenancy_id: party.tenancy_id, action: 'tenancy resumed', rule: 'R15' });
  } else if (paused) {
    await audit({ actor: 'relay', event_id: ev.event_id, tenancy_id: party.tenancy_id, action: 'blocked', result: `tenancy paused by ${tenancy.paused_by}` });
    return { status: 'blocked_paused' };
  }
  // 5. media
  const media_url = ev.media_id ? await registerWaMedia(ev.media_id, ev.mime) : '';
  const event = {
    event_type: 'message', event_id: ev.event_id, received_at: toIST(await nowMs()), tenancy_id: party.tenancy_id,
    from_msisdn: party.msisdn, from_role: party.role, message_type: ev.message_type, text: ev.text,
    button_id: ev.button_id, media_url, context_msg_id: ev.context_msg_id, demo_mode: true,
  };
  return forward(event);
}

export async function forward(event) {
  const l = await getLedger();
  if (config.aoRunUrl && config.aoApiKey) {
    const lockKey = `tenly:lock:${event.tenancy_id}`;
    for (let i = 0; i < 15 && !(await kv.set(lockKey, event.event_id, { ttlSec: 60, nx: true })); i += 1) await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await fetch(config.aoRunUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.aoApiKey}`, 'X-API-Key': config.aoApiKey },
        body: JSON.stringify({ payload: event, inputs: { event } }),
      });
      const body = await r.text();
      await audit({ actor: 'relay', event_id: event.event_id, tenancy_id: event.tenancy_id, action: 'forwarded to AgenticOrg', input_summary: `${event.from_role} ${event.message_type}`, result: `http ${r.status}`, external_ref: body.slice(0, 120) });
      if (r.ok) return { status: 'forwarded' };
    } finally { await kv.del(lockKey); }
  }
  await l.append('Inbox', [{ ...event, processed: 'FALSE', run_id: '' }]);
  await audit({ actor: 'relay', event_id: event.event_id, tenancy_id: event.tenancy_id, action: 'queued to Inbox', input_summary: `${event.from_role} ${event.message_type}${event.button_id ? ` ${event.button_id}` : ''}`, source_connector: 'whatsapp', source_ref: event.event_id });
  return { status: 'queued', event };
}

export function relayRoutes(app) {
  app.get('/webhooks/whatsapp', (c) => {
    if (c.req.query('hub.mode') === 'subscribe' && c.req.query('hub.verify_token') === config.metaVerifyToken) return c.text(c.req.query('hub.challenge') || '');
    return c.text('Forbidden', 403);
  });
  app.post('/webhooks/whatsapp', async (c) => {
    const raw = await c.req.text();
    if (!verifySignature(raw, c.req.header('x-hub-signature-256'))) {
      await audit({ actor: 'relay', action: 'rejected', result: 'bad X-Hub-Signature-256' });
      return c.text('Unauthorized', 401);
    }
    let body; try { body = JSON.parse(raw); } catch { return c.text('Bad Request', 400); }
    const msgs = (body.entry || []).flatMap((e) => (e.changes || []).flatMap((ch) => ch.value?.messages || []));
    const results = [];
    for (const m of msgs) results.push(await handleMessage(m));
    return c.json({ ok: true, results });
  });
}
