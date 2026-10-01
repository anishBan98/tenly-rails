// End to end: signed WhatsApp webhooks -> relay -> Inbox -> agent (over MCP) -> rails -> ledger,
// for the three recorded runs, then reconciliation of the three independent logs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, admin, webhook, waMessage, PARTY, KEYS, fakePlural } from './helpers.js';
import { RefAgent } from './ref-agent.js';
import { reconcile } from '../scripts/reconcile.js';

let srv; let agent; let plural;

before(async () => {
  srv = await start();
  plural = fakePlural();
  agent = new RefAgent({ baseUrl: srv.base, keys: KEYS, plural });
  await agent.connect();
});
after(async () => { await agent.close(); await srv.close(); });

const ledger = () => admin(srv.base, '/mock/ledger');
const outbox = () => admin(srv.base, '/mock/outbox?n=200');
const ob = async (id = 'OB-01') => (await ledger()).Obligations.find((o) => o.obligation_id === id);
async function voice(from, mediaId, transcript) {
  await admin(srv.base, '/mock/fixture/stt', { media_key: `wa_${mediaId}`, transcript });
  return webhook(srv.base, waMessage(from, 'audio', { media_id: mediaId }));
}
const say = (from, text) => webhook(srv.base, waMessage(from, 'text', text));
const tap = (from, id, title) => webhook(srv.base, waMessage(from, 'button', { id, title }));
const photo = (from, mediaId) => webhook(srv.base, waMessage(from, 'image', { media_id: mediaId, caption: 'done' }));
const tick = () => agent.tick();
const clock = (m) => admin(srv.base, '/mock/clock', { advance_minutes: m });

async function assertReconciled() {
  const r = reconcile(await ledger());
  assert.ok(r.pass, `reconcile failed: ${JSON.stringify(r.checks.filter((c) => !c.pass))}`);
  return r;
}

test('Run A: voice note -> clause 7(b) -> plumber booked within limit -> part shipped -> proof -> paid -> closed', async () => {
  await admin(srv.base, '/mock/reset', {});
  const v = await voice(PARTY.tenant, 'MEDIA-A1', 'bathroom ka nal leak ho raha hai');
  assert.equal(v.status, 200); assert.equal(v.body.results[0].status, 'queued');
  await tick();
  let o = await ob();
  assert.equal(o.state, 'NOTIFIED'); assert.equal(o.owed_by, 'owner'); assert.equal(o.source_ref, 'clause 7b');
  let msgs = await outbox();
  assert.ok(msgs.some((m) => m.to === PARTY.tenant && m.type === 'audio'), 'tenant got a Gnani voice reply');
  assert.ok(msgs.some((m) => m.to === PARTY.owner && /Clause 7b/.test(m.text?.body || '')), 'owner told what and why');
  assert.ok(msgs.some((m) => m.to === PARTY.tradesman && /Reply as/.test(m.text?.body || '')), 'plumber asked for a quote');

  await say(PARTY.tradesman, '1200, kal 11 baje, part: tap cartridge');
  await tick();
  o = await ob();
  assert.equal(o.state, 'IN_PROGRESS'); assert.equal(o.quote_paise, '120000'); assert.match(o.waybill, /^149\d+/);
  msgs = await outbox();
  assert.ok(msgs.some((m) => m.to === PARTY.owner && m.type === 'interactive'), 'owner got OK/Cancel/Not mine buttons');

  await tap(PARTY.owner, 'ok:OB-01', 'OK');
  await clock(6);
  for (let i = 0; i < 3; i += 1) await tick(); // tracking: In Transit -> Dispatched -> Delivered
  o = await ob();
  assert.match(o.notes, /part_delivered/);

  await photo(PARTY.tradesman, 'MEDIA-A2');
  await tick();
  o = await ob();
  assert.equal(o.state, 'PROOF_CHECK');
  await tap(PARTY.tenant, 'fixed:OB-01', 'Fixed');
  await tick();
  o = await ob();
  assert.equal(o.state, 'CLOSED'); assert.match(o.utr, /^\d{12}$/);
  const r = await assertReconciled();
  assert.equal(r.checks.length, 8);
});

test('Run B: owner taps "Not my responsibility" -> booking and shipment cancelled -> DISPUTED -> nothing paid', async () => {
  await admin(srv.base, '/mock/reset', {});
  await voice(PARTY.tenant, 'MEDIA-B1', 'bathroom ka nal leak ho raha hai');
  await tick();
  await say(PARTY.tradesman, '1200, kal 11 baje, part: tap cartridge');
  await tick();
  await tap(PARTY.owner, "notmine:OB-01", "Not responsible");
  const runs = await tick();
  const o = await ob();
  assert.equal(o.state, 'DISPUTED'); assert.equal(o.utr, ''); assert.equal(o.payout_id, '');
  assert.ok(runs.some((r) => r.needs_review), 'run output flags needs_review for the Approvals queue');
  const log = await admin(srv.base, '/mock/log?n=300');
  assert.ok(log.some((a) => a.action === 'POST /api/p/edit' && a.result === 'http 200'), 'shipment cancelled at Delhivery');
  const msgs = await outbox();
  assert.ok(msgs.some((m) => m.to === PARTY.tradesman && /Cancelled/.test(m.text?.body || '')));
  const tenantEvidence = msgs.find((m) => m.to === PARTY.tenant && /neutral reviewer/.test(m.text?.body || ''));
  const ownerEvidence = msgs.find((m) => m.to === PARTY.owner && /neutral reviewer/.test(m.text?.body || ''));
  assert.ok(tenantEvidence && ownerEvidence, 'both sides get the same evidence');
  await assertReconciled();
});

test('Run C: geyser Rs 6,500 over limit, owner silent -> reminder -> Gnani voice -> escalated -> late voice approval -> Plural link -> closed', async () => {
  await admin(srv.base, '/mock/reset', {});
  await voice(PARTY.tenant, 'MEDIA-C1', 'geyser kharab ho gaya hai paani garam nahi hota');
  await tick();
  await say(PARTY.tradesman, '6500, kal 10 baje, part: none');
  await tick();
  let o = await ob();
  assert.equal(o.state, 'NOTIFIED'); assert.match(o.notes, /awaiting_approval/);
  await clock(3.5); await tick();
  await clock(3.5); await tick();
  await clock(3.5); await tick();
  o = await ob();
  assert.equal(o.state, 'ESCALATED');
  const msgs = await outbox();
  assert.ok(msgs.some((m) => m.to === PARTY.owner && m.type === 'audio'), 'owner got a Gnani voice reminder');
  await voice(PARTY.owner, 'MEDIA-C2', 'haan geyser theek karwa do');
  await tick();
  o = await ob();
  assert.equal(o.state, 'IN_PROGRESS');
  await photo(PARTY.tradesman, 'MEDIA-C3');
  await tick();
  await tap(PARTY.tenant, 'fixed:OB-01', 'Fixed');
  await tick();
  o = await ob();
  assert.equal(o.state, 'PROOF_CHECK'); assert.match(o.payment_link_ref, /plural/);
  assert.equal(o.utr, '', 'no mandate debit above the Rs 4,000 grant');
  plural.markPaid(o.payment_link_ref);
  await tick();
  o = await ob();
  assert.equal(o.state, 'CLOSED');
  await assertReconciled();
});
