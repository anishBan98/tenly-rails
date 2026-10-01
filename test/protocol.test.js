// Protocol compliance: every MCP server works with the official MCP SDK client (what AgenticOrg
// discovers at registration), and the REST mocks answer on Delhivery's exact paths with its auth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { start, admin } from './helpers.js';

let srv;
before(async () => { srv = await start(); await admin(srv.base, '/mock/reset', {}); });
after(async () => srv.close());

const SERVERS = {
  sheets: ['dev-sheets', ['read_range', 'append_rows', 'update_range']],
  gnani: ['dev-gnani', ['stt', 'tts']],
  'wa-ui': ['dev-waui', ['send_text_message', 'send_interactive_message', 'send_media_message']],
  delhivery: ['dev-dlv', ['pincode_serviceability', 'create_shipment', 'pickup_request', 'track_shipment', 'cancel_shipment', 'ndr_action']],
  p3p: ['dev-p3p', ['createMandate', 'getMandateBalance', 'decidePayment']],
  caps: ['dev-caps', ['payout_individual', 'payout_status', 'split_debit', 'fulfillment_stock']],
};

for (const [path, [key, tools]] of Object.entries(SERVERS)) {
  test(`MCP /mcp/${path}: initialize + tools/list with the official SDK client`, async () => {
    const c = new Client({ name: 'compliance', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/${path}`), { requestInit: { headers: { 'x-api-key': key } } }));
    const listed = (await c.listTools()).tools;
    assert.deepEqual(listed.map((t) => t.name).sort(), [...tools].sort());
    for (const t of listed) { assert.ok(t.description.length > 30, `${t.name} has a description`); assert.equal(t.inputSchema.type, 'object'); }
    await c.close();
  });
}

test('MCP: wrong key is 401; bearer auth works; unknown tool and bad args are errors', async () => {
  const bad = await fetch(`${srv.base}/mcp/caps`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'nope' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(bad.status, 401);
  const post = (body) => fetch(`${srv.base}/mcp/caps`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-caps' }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.equal((await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } })).error.code, -32602);
  const missing = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'payout_status', arguments: {} } });
  assert.equal(missing.result.isError, true);
  const get = await fetch(`${srv.base}/mcp/caps`);
  assert.equal(get.status, 405);
});

test('Delhivery REST: exact paths, Token auth, stateful tracking, cancel', async () => {
  const H = { authorization: 'Token dev-dlv-token' };
  assert.equal((await fetch(`${srv.base}/c/api/pin-codes/json/?filter_codes=560034`)).status, 401);
  const pin = await (await fetch(`${srv.base}/c/api/pin-codes/json/?filter_codes=560034`, { headers: H })).json();
  assert.equal(pin.delivery_codes[0].postal_code.pre_paid, 'Y');
  const nsz = await (await fetch(`${srv.base}/c/api/pin-codes/json/?filter_codes=110001`, { headers: H })).json();
  assert.equal(nsz.delivery_codes.length, 0);
  const data = JSON.stringify({ shipments: [{ name: 'Priya', add: '14 5th Cross', pin: '560034', order: 'OB-9-part', products_desc: 'tap cartridge' }], pickup_location: { name: 'TENLY PARTS BLR' } });
  const created = await (await fetch(`${srv.base}/api/cmu/create.json`, { method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ format: 'json', data }) })).json();
  assert.equal(created.success, true);
  const wb = created.packages[0].waybill;
  const s1 = await (await fetch(`${srv.base}/api/v1/packages/json/?waybill=${wb}`, { headers: H })).json();
  assert.equal(s1.ShipmentData[0].Shipment.Status.Status, 'In Transit');
  const cancel = await (await fetch(`${srv.base}/api/p/edit`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ waybill: wb, cancellation: 'true' }) })).json();
  assert.equal(cancel.status, true);
  const pickup = await (await fetch(`${srv.base}/fm/request/new/`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ pickup_location: 'TENLY PARTS BLR', pickup_date: '2026-10-03', pickup_time: '11:00:00', expected_package_count: 1 }) })).json();
  assert.ok(pickup.pickup_id);
});

test('P3P REST: balance on GET /mpp/v1/balance; decidePayment 402 challenge then receipt; payout idempotency', async () => {
  const B = { authorization: 'Bearer dev-p3p-key', 'content-type': 'application/json' };
  const bal = await (await fetch(`${srv.base}/mpp/v1/balance?authorizationId=MND-302`, { headers: B })).json();
  assert.equal(bal.status, 'ACTIVE'); assert.equal(bal.balance_details.amount_remaining.value, 800000);
  const ch = await fetch(`${srv.base}/mpp/v1/payments/decide`, { method: 'POST', headers: B, body: JSON.stringify({ authorizationId: 'MND-302', amount_paise: 5000 }) });
  assert.equal(ch.status, 402); assert.match(ch.headers.get('www-authenticate'), /^Payment /);
  const ok = await fetch(`${srv.base}/mpp/v1/payments/decide`, { method: 'POST', headers: { ...B, 'p3p-credential': 'Payment', 'x-grantex-token': 'gx' }, body: JSON.stringify({ authorizationId: 'MND-302', amount_paise: 5000 }) });
  assert.equal(ok.status, 200); assert.ok(ok.headers.get('payment-receipt'));
  const C = { 'x-api-key': 'dev-caps-key', 'content-type': 'application/json', 'idempotency-key': 'k-1' };
  const body = JSON.stringify({ mandate_id: 'MND-302', amount_paise: 120000, payee_vpa: 'raju.plumber@okaxis', obligation_id: 'OB-1', proof: { tradesman_msg_id: 'a', tenant_confirm_msg_id: 'b' } });
  const p1 = await (await fetch(`${srv.base}/mpp/v1/payouts/individual`, { method: 'POST', headers: C, body })).json();
  const p2 = await fetch(`${srv.base}/mpp/v1/payouts/individual`, { method: 'POST', headers: C, body });
  assert.equal(p2.headers.get('idempotent-replay'), 'true');
  assert.equal((await p2.json()).utr, p1.utr);
});

test('Gnani TTS returns a playable signed media URL; tampered signatures are refused', async () => {
  const c = new Client({ name: 'g', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/gnani`), { requestInit: { headers: { 'x-api-key': 'dev-gnani' } } }));
  const r = await c.callTool({ name: 'tts', arguments: { text: 'Namaste', language: 'hi-IN' } });
  const url = r.structuredContent.audio_url;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url.replace(/sig=[0-9a-f]{4}/, 'sig=0000'))).status, 403);
  await c.close();
});
