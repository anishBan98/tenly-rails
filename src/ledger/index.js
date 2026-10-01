// Ledger facade + guardrails that the model cannot talk its way around:
//  - unknown tabs / columns are refused
//  - Audit is append-only
//  - Tenancy, Parties and Config are read-only to the agent (limits are set by humans)
//  - obligation state changes must follow the Q3 lifecycle; leaving DISPUTED needs a human review_ref
//  - CLOSED on a repair needs both proofs and a payment reference
import { config, isLive } from '../lib/config.js';
import { SCHEMA, TRANSITIONS, STATES, DEMO_SEED } from './schema.js';
import { createLocalLedger } from './local.js';
import { createSheetsLedger } from './sheets.js';
import { createKvLedger } from './kvledger.js';

let ledger = null;

export async function getLedger() {
  if (ledger) return ledger;
  if (isLive() && config.sheetId && config.googleSa) ledger = createSheetsLedger({ sheetId: config.sheetId, saJson: config.googleSa });
  else if (config.kvUrl && config.kvToken) {
    ledger = createKvLedger();
    if (await ledger.isEmpty()) await ledger.clearAndSeed(DEMO_SEED);
  } else ledger = createLocalLedger();
  return ledger;
}

export function _setLedger(l) { ledger = l; }

export class GuardError extends Error {}

const AGENT_WRITABLE = { Obligations: 'rw', Audit: 'append', Inbox: 'update' };
const INBOX_UPDATABLE = ['processed', 'run_id'];

function checkCols(tab, obj) {
  if (!SCHEMA[tab]) throw new GuardError(`unknown tab ${tab}; tabs: ${Object.keys(SCHEMA).join(', ')}`);
  const bad = Object.keys(obj).filter((k) => !SCHEMA[tab].includes(k));
  if (bad.length) throw new GuardError(`unknown column(s) ${bad.join(', ')} in ${tab}; columns: ${SCHEMA[tab].join(', ')}`);
}

export function checkObligationChange(cur, set) {
  if (!('state' in set) || set.state === cur.state) return;
  const to = set.state;
  if (!STATES.includes(to)) throw new GuardError(`unknown state ${to}`);
  const allowed = TRANSITIONS[cur.state] || [];
  if (!allowed.includes(to)) throw new GuardError(`illegal transition ${cur.state} -> ${to}; allowed from ${cur.state}: ${allowed.join(', ') || 'none'}`);
  if (cur.state === 'DISPUTED' && !(set.review_ref || cur.review_ref)) {
    throw new GuardError('leaving DISPUTED needs a human decision: set review_ref to the reviewer decision reference');
  }
  if (to === 'CLOSED' && (cur.type === 'repair')) {
    const merged = { ...cur, ...set };
    if (cur.state !== 'DISPUTED') {
      if (!merged.proof_tradesman_msg_id || !merged.proof_tenant_msg_id) {
        throw new GuardError('cannot close a repair without proof_tradesman_msg_id and proof_tenant_msg_id');
      }
      if (!merged.utr && !merged.payment_link_ref) {
        throw new GuardError('cannot close a repair without a payment reference (utr or payment_link_ref)');
      }
    }
  }
  if (!set.state_since) throw new GuardError('state changes must also set state_since');
}

// Agent-facing operations (called by the tenly_sheets MCP tools).
export const agentLedger = {
  async read(tab, where = {}) {
    if (!SCHEMA[tab]) checkCols(tab, {});
    // Reads are lenient: filters on columns a tab does not have are ignored (e.g. Config has no tenancy_id).
    where = Object.fromEntries(Object.entries(where || {}).filter(([k]) => SCHEMA[tab].includes(k)));
    const rows = await (await getLedger()).read(tab);
    return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === String(v)));
  },
  async append(tab, rows) {
    const mode = AGENT_WRITABLE[tab];
    if (!mode || mode === 'update') throw new GuardError(`${tab} is read-only for the agent`);
    for (const r of rows) {
      checkCols(tab, r);
      if (tab === 'Obligations') {
        if (!r.obligation_id || !r.tenancy_id) throw new GuardError('obligations need obligation_id and tenancy_id');
        if (!['RECORDED', 'DISPUTED'].includes(r.state)) throw new GuardError('a new obligation starts as RECORDED (or DISPUTED if no source covers it)');
        if (!r.owed_by || !r.source_type || !r.source_ref) throw new GuardError('an obligation needs owed_by, source_type and source_ref (R3)');
        const exists = (await (await getLedger()).read('Obligations')).some((o) => o.obligation_id === r.obligation_id);
        if (exists) throw new GuardError(`obligation ${r.obligation_id} already exists`);
      }
      if (tab === 'Audit') {
        if (!r.event_id || !r.decision || !r.rule) throw new GuardError('agent audit rows need event_id, decision and rule');
        r.actor = 'agent';
      }
    }
    return (await getLedger()).append(tab, rows);
  },
  async update(tab, where, set) {
    const mode = AGENT_WRITABLE[tab];
    if (!mode || mode === 'append') throw new GuardError(`${tab} cannot be updated by the agent`);
    checkCols(tab, where); checkCols(tab, set);
    if (!Object.keys(where).length) throw new GuardError('update needs a where filter');
    if (tab === 'Inbox') {
      const bad = Object.keys(set).filter((k) => !INBOX_UPDATABLE.includes(k));
      if (bad.length) throw new GuardError(`only ${INBOX_UPDATABLE.join(', ')} can be updated in Inbox`);
    }
    const l = await getLedger();
    if (tab === 'Obligations') {
      if (!where.obligation_id) throw new GuardError('update Obligations by obligation_id');
      const cur = (await l.read('Obligations')).find((o) => o.obligation_id === String(where.obligation_id));
      if (!cur) throw new GuardError(`no obligation ${where.obligation_id}`);
      if ('obligation_id' in set || 'tenancy_id' in set) throw new GuardError('obligation_id and tenancy_id cannot change');
      checkObligationChange(cur, set);
    }
    for (const [k, v] of Object.entries(set)) if (typeof v === 'boolean' || /^(true|false)$/i.test(String(v))) set[k] = String(v).toUpperCase();
    const n = await l.updateWhere(tab, where, set);
    if (!n) throw new GuardError(`no ${tab} row matched ${JSON.stringify(where)}`);
    return n;
  },
};

export async function resetLedger(seed = DEMO_SEED) {
  const l = await getLedger();
  if (l.kind === 'local') l.reset(seed);
  else await l.clearAndSeed(seed);
}
