// Independent audit writer for the relay, the mocks and the wrappers. The agent writes its own
// decision rows through tenly_sheets; these rows are the second witness that reconciliation
// compares against. Rows go to the ledger's Audit tab and a capped KV list (GET /mock/log).
import { kv } from './kv.js';
import { nowIST } from './clock.js';
import { getLedger } from '../ledger/index.js';

let seq = 0;

export async function audit(row) {
  const full = {
    audit_id: `A-${Date.now().toString(36)}-${(++seq).toString(36)}`,
    ts_ist: await nowIST(),
    event_id: '', run_id: '', actor: 'mock', tenancy_id: '', obligation_id: '',
    state_from: '', state_to: '', input_summary: '', source_connector: '', source_ref: '',
    decision: '', rule: '', action: '', to: '', message_text: '', via_connector: '',
    result: '', external_ref: '', prompt_version: '',
    ...row,
  };
  for (const k of Object.keys(full)) {
    if (full[k] != null && typeof full[k] === 'object') full[k] = JSON.stringify(full[k]);
    if (full[k] == null) full[k] = '';
    full[k] = String(full[k]).slice(0, 1000);
  }
  await kv.lpushCapped('tenly:auditlog', full, 500);
  try {
    await (await getLedger()).append('Audit', [full], { system: true });
  } catch (e) {
    // Never lose the row silently: it is still in the KV log, and the failure is visible there.
    await kv.lpushCapped('tenly:auditlog', { ...full, action: 'AUDIT WRITE FAILED', result: String(e.message) }, 500);
  }
  return full;
}

export const maskPhone = (p) => (p ? `xxxxxx${String(p).slice(-4)}` : '');
