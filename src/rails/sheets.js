// tenly_sheets MCP tools: the agent's memory and the shared record (REAL Google Sheets in live
// mode). Guardrails live in src/ledger/index.js and cannot be bypassed from the prompt.
import { agentLedger, GuardError } from '../ledger/index.js';
import { SCHEMA } from '../ledger/schema.js';
import { audit } from '../lib/audit.js';
import { toolError } from '../lib/mcp.js';
import { nowIST } from '../lib/clock.js';

const TABS = Object.keys(SCHEMA);
const wrap = (name, fn) => async (a) => {
  try { return await fn(a); } catch (e) {
    if (e instanceof GuardError) {
      await audit({ actor: 'guard', source_connector: 'tenly_sheets', action: `${name} refused`, input_summary: JSON.stringify(a).slice(0, 300), result: e.message });
      return toolError({ error: 'refused_by_guardrail', detail: e.message });
    }
    throw e;
  }
};

export const sheetsTools = [
  {
    name: 'read_range',
    description: `Read rows from a tab of the tenancy Sheet as objects. Tabs: ${TABS.join(', ')}. Optional "where" filters by exact column values, e.g. {"tenancy_id":"T-302"} or {"processed":"FALSE"}. Amounts are in paise; times are ISO 8601 IST. Also returns now_ist (the demo clock).`,
    inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: TABS }, where: { type: 'object' } }, required: ['tab'] },
    // Free text such as "Tenancy, Parties, Obligations" reads several tabs at once.
    coerce: (a) => {
      if (a.tab || typeof a.query !== 'string') return a;
      const tabs = TABS.filter((t) => new RegExp(t, 'i').test(a.query));
      return { ...a, tab: tabs[0] || '', tabs };
    },
    handler: wrap('read_range', async (a) => {
      const now_ist = await nowIST();
      if (Array.isArray(a.tabs) && a.tabs.length > 1) {
        const out = {};
        for (const t of a.tabs) out[t] = await agentLedger.read(t, a.where || {});
        return { now_ist, tabs: out, note: 'Several tabs read; pass {"tab": NAME} to read one.' };
      }
      return { tab: a.tab, now_ist, rows: await agentLedger.read(a.tab, a.where || {}) };
    }),
  },
  {
    name: 'append_rows',
    description: 'Append rows to Obligations or Audit. Each row is an OBJECT keyed by column name (never a list of values), e.g. {"tab":"Obligations","rows":[{"obligation_id":"OB-1","tenancy_id":"T-302","type":"repair","title":"Kitchen tap leak","owed_by":"owner","owed_to":"tenant","source_type":"clause","source_ref":"7b","due_at":"2026-10-01T15:00:00+05:30","state":"RECORDED","state_since":"2026-10-01T14:40:00+05:30"}]}. New obligations start as RECORDED and need obligation_id, tenancy_id, owed_by, source_type and source_ref. Agent Audit rows need event_id, decision and rule; actor is set to "agent". Unknown columns are refused.',
    inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['Obligations', 'Audit'] }, rows: { type: 'array', items: { type: 'object' } } }, required: ['tab', 'rows'] },
    handler: wrap('append_rows', async (a) => {
      const rows = Array.isArray(a.rows) ? a.rows : [a.rows];
      // A list of values is accepted only when it has exactly one value per column, in column order.
      const fixed = rows.map((r) => (Array.isArray(r) && r.length === SCHEMA[a.tab]?.length ? Object.fromEntries(SCHEMA[a.tab].map((c, i) => [c, r[i]])) : r));
      if (fixed.some((r) => Array.isArray(r) || !r || typeof r !== 'object')) {
        return toolError({ error: 'rows must be objects keyed by column name, not lists of values', columns: SCHEMA[a.tab], example: { [SCHEMA[a.tab][0]]: '...', [SCHEMA[a.tab][1]]: '...' } });
      }
      return { appended: await agentLedger.append(a.tab, fixed) };
    }),
  },
  {
    name: 'update_range',
    description: 'Update rows matching "where" with the columns in "set". Obligations: match by obligation_id; a state change must follow the lifecycle (RECORDED->NOTIFIED->IN_PROGRESS->PROOF_CHECK->CLOSED, side states ESCALATED/DISPUTED) and must also set state_since; leaving DISPUTED needs review_ref; closing a repair needs both proofs and a utr or payment_link_ref. Inbox: only processed and run_id. Tenancy, Parties, Config and Audit cannot be updated.',
    inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['Obligations', 'Inbox'] }, where: { type: 'object' }, set: { type: 'object' } }, required: ['tab', 'where', 'set'] },
    handler: wrap('update_range', async (a) => ({ updated: await agentLedger.update(a.tab, a.where, a.set) })),
  },
];
