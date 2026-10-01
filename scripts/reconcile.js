// Reconciliation: three writers (relay, mocks/wrappers, agent) log independently; this checks
// that their stories agree. Run after every test round and before the final recordings:
//   node scripts/reconcile.js https://<your-app>  (reads /mock/ledger with ADMIN_KEY)
import { TRANSITIONS } from '../src/ledger/schema.js';

export function reconcile({ Audit = [], Obligations = [], Inbox = [], Parties = [] }) {
  const checks = [];
  const add = (name, fails) => checks.push({ check: name, pass: fails.length === 0, detail: fails.slice(0, 5).join('; ') });
  const agent = Audit.filter((a) => a.actor === 'agent');
  const agentEvents = new Set(agent.map((a) => a.event_id));

  // 1. every event the relay queued or forwarded was handled by the agent
  const relayed = Audit.filter((a) => a.actor === 'relay' && /queued to Inbox|forwarded/.test(a.action)).map((a) => a.event_id);
  add('every relayed event has an agent decision', relayed.filter((e) => !agentEvents.has(e)).map((e) => `no agent row for ${e}`));

  // 2. payments only after both proofs, with a reference
  add('every payout has a UTR and both proofs', Obligations.filter((o) => o.payout_id || o.utr).filter((o) => !o.utr || !o.proof_tradesman_msg_id || !o.proof_tenant_msg_id).map((o) => `${o.obligation_id}: utr=${o.utr || '-'} proofs=${Boolean(o.proof_tradesman_msg_id)}/${Boolean(o.proof_tenant_msg_id)}`));

  // 3. only allowed state transitions, in the agent's own log
  const bad = agent.filter((a) => a.state_from && a.state_to && a.state_from !== a.state_to && !(TRANSITIONS[a.state_from] || []).includes(a.state_to));
  add('only allowed state transitions', bad.map((a) => `${a.obligation_id} ${a.state_from}->${a.state_to}`));

  // 4. nothing CLOSED without passing PROOF_CHECK
  const closedWithoutProof = Obligations.filter((o) => o.state === 'CLOSED' && o.type === 'repair' && !agent.some((a) => a.obligation_id === o.obligation_id && a.state_to === 'PROOF_CHECK'));
  add('no repair closed without PROOF_CHECK', closedWithoutProof.map((o) => o.obligation_id));

  // 5. every voice note went through Gnani
  const voiceIn = Inbox.filter((e) => e.message_type === 'audio').length;
  const sttCalls = Audit.filter((a) => a.source_connector === 'tenly_gnani' && a.action === 'stt' && a.actor === 'wrapper').length;
  add('every voice note transcribed by Gnani', sttCalls >= voiceIn ? [] : [`${voiceIn} voice notes, ${sttCalls} Gnani STT calls`]);

  // 6. no agent action while a tenancy was paused
  const pauses = Audit.filter((a) => a.actor === 'relay' && /tenancy (paused|resumed)/.test(a.action)).sort((x, y) => x.ts_ist.localeCompare(y.ts_ist));
  const windows = []; let open = null;
  for (const p of pauses) { if (p.action === 'tenancy paused') open = p.ts_ist; else if (open) { windows.push([open, p.ts_ist]); open = null; } }
  if (open) windows.push([open, '9999']);
  const during = agent.filter((a) => a.action.startsWith('send') && windows.some(([s, e]) => a.ts_ist > s && a.ts_ist < e) && a.rule !== 'R15');
  add('no agent messages while paused', during.map((a) => `${a.audit_id} ${a.action}`));

  // 7. every outbound message went to a tenancy party
  const known = new Set(Parties.map((p) => `${p.role}:${p.name}`));
  add('messages only to tenancy parties', agent.filter((a) => a.to && !a.to.split(',').every((t) => known.has(t.trim()))).map((a) => `${a.audit_id} to ${a.to}`));

  // 8. nothing silently dropped by the guardrails
  const refused = Audit.filter((a) => a.actor === 'guard');
  add('no guardrail refusals', refused.map((a) => `${a.action}: ${a.result}`));

  return { pass: checks.every((c) => c.pass), checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] || 'http://localhost:8787';
  const r = await fetch(`${base}/mock/ledger`, { headers: { 'x-admin-key': process.env.ADMIN_KEY || 'dev-admin-key' } });
  const res = reconcile(await r.json());
  console.table(res.checks);
  process.exit(res.pass ? 0 : 1);
}
