// Tiny key-value store: Upstash Redis REST (Vercel KV) when configured, memory otherwise.
// Serverless functions keep no memory between invocations, so production must set KV_*.
import { config } from './config.js';

const mem = new Map(); // key -> { v, exp }

function memGet(k) {
  const e = mem.get(k);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(k); return null; }
  return e.v;
}

async function upstash(cmd) {
  const r = await fetch(config.kvUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.kvToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`kv ${cmd[0]} failed: ${r.status}`);
  return (await r.json()).result;
}

const useRemote = () => Boolean(config.kvUrl && config.kvToken);

export const kv = {
  async get(k) {
    if (!useRemote()) return memGet(k);
    const v = await upstash(['GET', k]);
    return v == null ? null : JSON.parse(v);
  },
  async set(k, v, { ttlSec, nx } = {}) {
    if (!useRemote()) {
      if (nx && memGet(k) != null) return false;
      mem.set(k, { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
      return true;
    }
    const cmd = ['SET', k, JSON.stringify(v)];
    if (ttlSec) cmd.push('EX', String(ttlSec));
    if (nx) cmd.push('NX');
    return (await upstash(cmd)) === 'OK';
  },
  async del(k) {
    if (!useRemote()) return mem.delete(k);
    return upstash(['DEL', k]);
  },
  async incr(k) {
    if (!useRemote()) { const n = (memGet(k) || 0) + 1; mem.set(k, { v: n, exp: 0 }); return n; }
    return upstash(['INCR', k]);
  },
  async lpushCapped(k, v, cap = 500) {
    if (!useRemote()) { const a = memGet(k) || []; a.unshift(v); mem.set(k, { v: a.slice(0, cap), exp: 0 }); return; }
    await upstash(['LPUSH', k, JSON.stringify(v)]);
    await upstash(['LTRIM', k, '0', String(cap - 1)]);
  },
  async lrange(k, n = 100) {
    if (!useRemote()) return (memGet(k) || []).slice(0, n);
    return (await upstash(['LRANGE', k, '0', String(n - 1)])).map((s) => JSON.parse(s));
  },
  async flushPrefix(prefix) {
    if (!useRemote()) { for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k); return; }
    let cursor = '0';
    do {
      const [next, keys] = await upstash(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '200']);
      cursor = next;
      if (keys.length) await upstash(['DEL', ...keys]);
    } while (cursor !== '0');
  },
  _memClear() { mem.clear(); },
};
