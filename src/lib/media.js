// Media store + signed URLs. Voice notes and photos arrive as WhatsApp media IDs that need the
// Meta token to download; Gnani TTS returns raw audio bytes. Both become short-lived signed URLs
// on this server, so the agent only ever handles URLs, and WhatsApp's send_media_message
// (which accepts media_url) can send a Gnani voice reply directly.
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { kv } from './kv.js';
import { config, isLive } from './config.js';

const sign = (id, exp) => createHmac('sha256', config.mediaSecret).update(`${id}.${exp}`).digest('hex').slice(0, 32);

export function signedUrl(id, ttlSec = 86400) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${config.baseUrl}/media/${encodeURIComponent(id)}?exp=${exp}&sig=${sign(id, exp)}`;
}

export function verify(id, exp, sig) {
  return Number(exp) > Date.now() / 1000 && sig === sign(id, exp);
}

// Stored bytes (TTS output, test fixtures)
export async function putBytes(bytes, mime, ttlSec = 3 * 86400) {
  const id = `m_${randomBytes(9).toString('hex')}`;
  await kv.set(`tenly:media:${id}`, { mime, b64: Buffer.from(bytes).toString('base64') }, { ttlSec });
  return { id, url: signedUrl(id, ttlSec), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

// WhatsApp inbound media: remember the media ID; bytes are fetched from Meta only when needed.
export async function registerWaMedia(mediaId, mime) {
  const id = `wa_${mediaId}`;
  await kv.set(`tenly:media:${id}`, { wa_media_id: mediaId, mime }, { ttlSec: 7 * 86400 });
  return signedUrl(id, 3 * 3600);
}

export async function getBytes(id) {
  const rec = await kv.get(`tenly:media:${id}`);
  if (!rec) return null;
  if (rec.b64) return { mime: rec.mime, bytes: Buffer.from(rec.b64, 'base64') };
  if (rec.wa_media_id) {
    if (!isLive()) {
      const fx = await kv.get(`tenly:fixture:wa:${rec.wa_media_id}`);
      return { mime: rec.mime || 'audio/ogg', bytes: Buffer.from(fx?.b64 || 'T2dnUw==', 'base64') };
    }
    const meta = await fetch(`${config.graphBase}/${rec.wa_media_id}`, { headers: { Authorization: `Bearer ${config.waToken}` } });
    if (!meta.ok) throw new Error(`Graph media lookup ${meta.status}`);
    const { url, mime_type: mt } = await meta.json();
    const r = await fetch(url, { headers: { Authorization: `Bearer ${config.waToken}` } });
    if (!r.ok) throw new Error(`Graph media download ${r.status}`);
    return { mime: mt || rec.mime, bytes: Buffer.from(await r.arrayBuffer()) };
  }
  return null;
}

// Resolve a URL we issued without an HTTP round trip; fall back to fetching anything else.
export async function bytesFromUrl(url) {
  try {
    const u = new URL(url);
    if (url.startsWith(config.baseUrl) && u.pathname.startsWith('/media/')) {
      const id = decodeURIComponent(u.pathname.slice('/media/'.length));
      if (!verify(id, u.searchParams.get('exp'), u.searchParams.get('sig'))) throw new Error('media URL expired or invalid signature');
      const got = await getBytes(id);
      if (!got) throw new Error('media not found');
      return got;
    }
  } catch (e) {
    if (String(e.message).startsWith('media')) throw e;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return { mime: r.headers.get('content-type') || 'application/octet-stream', bytes: Buffer.from(await r.arrayBuffer()) };
}

export function mediaRoutes(app) {
  app.get('/media/:id', async (c) => {
    const id = c.req.param('id');
    if (!verify(id, c.req.query('exp'), c.req.query('sig'))) return c.text('Forbidden', 403);
    try {
      const got = await getBytes(id);
      if (!got) return c.text('Not found', 404);
      return c.body(got.bytes, 200, { 'Content-Type': got.mime, 'Cache-Control': 'private, max-age=300' });
    } catch (e) {
      return c.text(`Upstream error: ${e.message}`, 502);
    }
  });
}
