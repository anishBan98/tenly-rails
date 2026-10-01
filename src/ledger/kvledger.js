// Ledger stored in Upstash Redis (Vercel KV), one JSON array per tab. Same semantics as the Sheet.
// Used in live mode when no Google service account is configured, so the deployed app keeps state
// across serverless invocations. A per-tab lock serialises read-modify-write.
import { SCHEMA, DEMO_SEED } from './schema.js';
import { kv } from '../lib/kv.js';

const key = (tab) => `tenly:ledger:${tab}`;
const normalise = (tab, r) => Object.fromEntries(SCHEMA[tab].map((c) => [c, r[c] == null ? '' : String(r[c])]));

async function withLock(tab, fn) {
  const lk = `tenly:ledgerlock:${tab}`;
  for (let i = 0; i < 40; i += 1) {
    if (await kv.set(lk, 1, { ttlSec: 10, nx: true })) {
      try { return await fn(); } finally { await kv.del(lk); }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`ledger busy: ${tab}`);
}

export function createKvLedger() {
  const readTab = async (tab) => (await kv.get(key(tab))) || [];
  return {
    kind: 'kv',
    async read(tab) { return (await readTab(tab)).map((r) => normalise(tab, r)); },
    async append(tab, rows) {
      return withLock(tab, async () => {
        const cur = await readTab(tab);
        for (const r of rows) cur.push(normalise(tab, r));
        await kv.set(key(tab), cur);
        return rows.length;
      });
    },
    async updateWhere(tab, match, set) {
      return withLock(tab, async () => {
        const cur = await readTab(tab);
        let n = 0;
        for (const r of cur) {
          if (Object.entries(match).every(([k, v]) => String(r[k] ?? '') === String(v))) {
            for (const [k, v] of Object.entries(set)) r[k] = v == null ? '' : String(v);
            n += 1;
          }
        }
        if (n) await kv.set(key(tab), cur);
        return n;
      });
    },
    async clearAndSeed(seed = DEMO_SEED) {
      for (const tab of Object.keys(SCHEMA)) await kv.set(key(tab), (seed[tab] || []).map((r) => normalise(tab, r)));
    },
    async isEmpty() { return (await kv.get(key('Tenancy'))) == null; },
  };
}
