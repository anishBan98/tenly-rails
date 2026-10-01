// In-memory ledger with the same semantics as the Google Sheet (used in local mode and tests).
import { SCHEMA, DEMO_SEED } from './schema.js';

export function createLocalLedger() {
  let tables = {};
  const reset = (seed = DEMO_SEED) => {
    tables = {};
    for (const tab of Object.keys(SCHEMA)) tables[tab] = (seed[tab] || []).map((r) => normalise(tab, r));
  };
  const normalise = (tab, r) => Object.fromEntries(SCHEMA[tab].map((c) => [c, r[c] == null ? '' : String(r[c])]));
  reset();

  return {
    kind: 'local',
    reset,
    async read(tab) { return tables[tab].map((r) => ({ ...r })); },
    async append(tab, rows) { for (const r of rows) tables[tab].push(normalise(tab, r)); return rows.length; },
    async updateWhere(tab, match, set) {
      let n = 0;
      for (const r of tables[tab]) {
        if (Object.entries(match).every(([k, v]) => r[k] === String(v))) {
          for (const [k, v] of Object.entries(set)) r[k] = v == null ? '' : String(v);
          n += 1;
        }
      }
      return n;
    },
    dump() { return JSON.parse(JSON.stringify(tables)); },
  };
}
