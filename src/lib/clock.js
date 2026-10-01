// Demo clock. The recording must reach the outcome in one sitting, so testers can move time
// forward (POST /mock/clock) instead of waiting 24 hours. Every timestamp the rails produce
// comes from here, in IST.
import { kv } from './kv.js';

export async function nowMs() {
  const off = (await kv.get('tenly:clock:offset_ms')) || 0;
  return Date.now() + off;
}

export async function advance(minutes) {
  const off = ((await kv.get('tenly:clock:offset_ms')) || 0) + Math.round(minutes * 60000);
  await kv.set('tenly:clock:offset_ms', off);
  return off;
}

export async function resetClock() { await kv.del('tenly:clock:offset_ms'); }

export function toIST(ms) {
  const d = new Date(ms + 5.5 * 3600 * 1000);
  return d.toISOString().replace('Z', '+05:30').replace(/\.\d{3}/, '');
}

export async function nowIST() { return toIST(await nowMs()); }
