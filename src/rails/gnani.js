// Gnani wrapper (REAL tool in live mode). Every voice input and reply goes through Gnani:
//   STT  POST https://api.vachana.ai/stt/v3  (multipart: audio_file, language_code, ...)  X-API-Key-ID
//   TTS  POST https://api.vachana.ai/api/v1/tts/inference (JSON) -> raw audio bytes
// The MCP tools pass Gnani's own response through unchanged (request_id included) so every
// transcript can be traced to a Gnani call in the audit.
import { config, isLive } from '../lib/config.js';
import { kv } from '../lib/kv.js';
import { audit } from '../lib/audit.js';
import { takeScenario } from '../lib/scenario.js';
import { bytesFromUrl, putBytes } from '../lib/media.js';
import { toolError } from '../lib/mcp.js';

const LANGS = ['hi-IN', 'en-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'pa-IN', 'ta-IN', 'te-IN'];

export async function stt({ audio_url, language_code, bias_list }) {
  const scn = await takeScenario('gnani.stt');
  const { mime, bytes } = await bytesFromUrl(audio_url);
  if (!isLive()) {
    // Local mode: a fixture transcript registered for this audio (tests) or a default.
    const key = new URL(audio_url).pathname.split('/').pop();
    const fx = await kv.get(`tenly:fixture:stt:${decodeURIComponent(key)}`);
    const transcript = scn === 'stt_empty' ? '' : (fx?.transcript ?? 'bathroom ka nal leak ho raha hai');
    return { gnani_status: 200, success: true, request_id: `req_fake_${Date.now().toString(36)}`, transcript, language_code, fake: true };
  }
  if (!config.gnaniKey) return toolError({ error: 'GNANI_API_KEY is not set' });
  const form = new FormData();
  const ext = (mime || '').includes('ogg') ? 'ogg' : (mime || '').includes('mpeg') ? 'mp3' : 'wav';
  form.append('audio_file', new Blob([bytes], { type: mime || 'audio/ogg' }), `voice.${ext}`);
  form.append('language_code', language_code);
  form.append('format', 'transcribe');
  if (bias_list?.length) { form.append('bias_list', JSON.stringify(bias_list.slice(0, 100))); form.append('bias_score', '1.0'); }
  const r = await fetch(config.gnaniSttUrl, { method: 'POST', headers: { 'X-API-Key-ID': config.gnaniKey }, body: form });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
  const out = { gnani_status: r.status, ...body };
  return r.ok ? out : toolError(out);
}

export async function tts({ text, language, voice }) {
  await takeScenario('gnani.tts');
  if (!isLive()) {
    const fake = Buffer.from(`OggS-fake-tts:${language}:${text}`);
    const m = await putBytes(fake, 'audio/ogg');
    return { gnani_status: 200, audio_url: m.url, media_id: m.id, bytes: m.bytes, sha256: m.sha256, language, fake: true };
  }
  if (!config.gnaniKey) return toolError({ error: 'GNANI_API_KEY is not set' });
  const r = await fetch(config.gnaniTtsUrl, {
    method: 'POST',
    headers: { 'X-API-Key-ID': config.gnaniKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model: 'timbre-v2.5', voice: voice || config.gnaniVoice, language, audio_config: { sample_rate: 16000, container: 'ogg', encoding: 'oggopus', num_channels: 1 } }),
  });
  if (!r.ok) return toolError({ gnani_status: r.status, error: (await r.text()).slice(0, 500) });
  const bytes = Buffer.from(await r.arrayBuffer());
  const m = await putBytes(bytes, r.headers.get('content-type') || 'audio/ogg');
  return { gnani_status: r.status, audio_url: m.url, media_id: m.id, bytes: m.bytes, sha256: m.sha256, language };
}

export const gnaniTools = [
  {
    name: 'stt',
    description: 'Gnani speech-to-text (REAL Gnani API, POST https://api.vachana.ai/stt/v3). Pass the media_url from the event (a WhatsApp voice note) and language_code. Returns Gnani\'s own response: transcript, request_id, success. An empty transcript means you must ask the person to re-record or type (R2). Audio up to 60 seconds.',
    inputSchema: { type: 'object', properties: { audio_url: { type: 'string' }, language_code: { type: 'string', enum: LANGS }, bias_list: { type: 'array', items: { type: 'string' } } }, required: ['audio_url', 'language_code'] },
    handler: async (a) => {
      const out = await stt(a);
      await audit({ actor: 'wrapper', source_connector: 'tenly_gnani', action: 'stt', external_ref: out.request_id || '', result: `gnani ${out.gnani_status} transcript_chars=${(out.transcript || '').length}` });
      return out;
    },
  },
  {
    name: 'tts',
    description: 'Gnani text-to-speech (REAL Gnani API, POST https://api.vachana.ai/api/v1/tts/inference, model timbre-v2.5, OGG/Opus). Returns audio_url: send it with whatsapp send_media_message (type audio, media_url=audio_url) as the voice reply.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, language: { type: 'string', enum: [...LANGS, 'auto'] }, voice: { type: 'string' } }, required: ['text', 'language'] },
    handler: async (a) => {
      const out = await tts(a);
      await audit({ actor: 'wrapper', source_connector: 'tenly_gnani', action: 'tts', external_ref: out.sha256 || '', result: `gnani ${out.gnani_status} bytes=${out.bytes || 0}` });
      return out;
    },
  },
];
