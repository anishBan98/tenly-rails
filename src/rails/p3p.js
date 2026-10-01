// Pine Labs P3P mock (agentic payments on UPI). Method and field names follow the P3P quickstart:
// createMandate(customerReference, mobileNumber, amount, paymentMethod) -> deep_link;
// getMandateBalance via GET /mpp/v1/balance -> status, amount.value, balance_details;
// decidePayment -> 402 challenge (WWW-Authenticate: Payment ...) until P3P-Credential and
// X-Grantex-Token are sent, then Payment-Receipt.
// Plus TenLy's capabilities that P3P does not offer today (see capsTools).
import { kv } from '../lib/kv.js';
import { config } from '../lib/config.js';
import { nowIST } from '../lib/clock.js';
import { common, send, asTool, logCall, rid } from './common.js';
import { sleep, timeoutMs, takeScenario } from '../lib/scenario.js';

const M = (id) => `tenly:p3p:mandate:${id}`;
const METHODS = ['RESERVE_PAY', 'OTM', 'CARD'];

export async function seedMandates() {
  await kv.set(M('MND-302'), {
    authorizationId: 'MND-302', customerReference: 'owner-T-302', mobileNumber: '919000000002',
    paymentMethod: 'RESERVE_PAY', amount: 800000, blocked: 800000, debited: 0, status: 'ACTIVE',
  });
}

function balanceBody(m) {
  return {
    authorizationId: m.authorizationId, status: m.status, paymentMethod: m.paymentMethod,
    amount: { value: m.amount, currency: 'INR' },
    balance_details: {
      amount_blocked: { value: m.blocked, currency: 'INR' },
      amount_debited: { value: m.debited, currency: 'INR' },
      amount_remaining: { value: m.amount - m.debited, currency: 'INR' },
    },
  };
}

export const p3p = {
  async createMandate(a) {
    const { scn, override } = await common('p3p.create');
    if (override) return { scn, res: override };
    if (!a.customerReference || !a.mobileNumber || !Number.isInteger(a.amount) || !METHODS.includes(a.paymentMethod)) {
      return { scn, res: { status: 400, body: { type: 'about:blank', title: 'Bad Request', detail: 'customerReference, mobileNumber, amount (paise, integer) and paymentMethod (RESERVE_PAY|OTM|CARD) are required' } } };
    }
    const id = `MND-${Date.now().toString(36).toUpperCase()}`;
    const m = { authorizationId: id, customerReference: a.customerReference, mobileNumber: a.mobileNumber, paymentMethod: a.paymentMethod, amount: a.amount, blocked: 0, debited: 0, status: 'PENDING' };
    await kv.set(M(id), m);
    const body = { authorizationId: id, status: 'PENDING' };
    if (a.paymentMethod === 'CARD') body.checkout_url = `${config.baseUrl}/mock/approve-mandate/${id}`;
    else body.deep_link = `upi://mandate?pa=tenly@pinelabs&pn=TenLy&am=${(a.amount / 100).toFixed(2)}&tr=${id}&mode=04`;
    return { scn, res: { status: 201, body } };
  },

  async getMandateBalance(a) {
    const { scn, override } = await common('p3p.balance');
    if (override) return { scn, res: override };
    const m = await kv.get(M(a.authorizationId));
    if (!m) return { scn, res: { status: 404, body: { title: 'Not Found', detail: `no mandate ${a.authorizationId}` } } };
    const b = balanceBody(m);
    if (scn === 'mandate_inactive') b.status = 'PAUSED';
    if (scn === 'insufficient_balance') b.balance_details.amount_remaining.value = 50000;
    return { scn, res: { status: 200, body: b } };
  },

  async decidePayment(a) {
    const { scn, override } = await common('p3p.decide');
    if (override) return { scn, res: override };
    const challenge = `Payment realm="tenly", id="${rid()}", amount="${a.amount_paise}", currency="INR"`;
    if (scn === 'challenge_402' || a.credential !== 'Payment' || !a.grantex_token) {
      return { scn, res: { status: 402, headers: { 'WWW-Authenticate': challenge }, body: { decision: { action: 'challenge', status: 402, headers: { 'WWW-Authenticate': challenge }, problemDetails: { type: 'https://pinelabs.com/p3p/payment-required', title: 'Payment Required', detail: 'Send P3P-Credential: Payment and X-Grantex-Token' } } } } };
    }
    const m = await kv.get(M(a.authorizationId));
    if (!m || m.status !== 'ACTIVE') return { scn, res: { status: 409, body: { decision: { action: 'reject', status: 409, problemDetails: { title: 'Mandate not active' } } } } };
    if (m.amount - m.debited < a.amount_paise) return { scn, res: { status: 402, body: { decision: { action: 'reject', status: 402, problemDetails: { title: 'Insufficient mandate balance' } } } } };
    m.debited += a.amount_paise; await kv.set(M(m.authorizationId), m);
    const receipt = `rcpt_${rid()}`;
    return { scn, res: { status: 200, headers: { 'Payment-Receipt': receipt }, body: { decision: { action: 'proceed', status: 200, headers: { 'Payment-Receipt': receipt } } } } };
  },

  async approveMandate(id) {
    const m = await kv.get(M(id));
    if (!m) return false;
    m.status = 'ACTIVE'; m.blocked = m.amount; await kv.set(M(id), m);
    return true;
  },
};

// ---------------- TenLy capabilities (not offered by the rails today) ----------------
const P = (k) => `tenly:payout:${k}`;
const utr = () => `6${String(Date.now()).slice(-10)}${Math.floor(Math.random() * 10)}`;

export const caps = {
  // Pine Labs gap: pay an INDIVIDUAL tradesman (not a merchant) from the owner's mandate, against proof.
  async payoutIndividual(a, idemKey) {
    if (!idemKey) return { scn: 'ok', res: { status: 400, body: { error: 'Idempotency-Key header is required' } } };
    const prior = await kv.get(P(idemKey));
    if (prior) return { scn: 'replay', res: { status: 200, headers: { 'Idempotent-Replay': 'true' }, body: prior } };
    // "timeout" is special here: the payout IS processed, but the caller never hears back,
    // which is exactly the case R13 guards against (check status before any retry).
    const scnInfo = await takeScenario('caps.payout');
    if (['http500', 'malformed', 'html_error', 'rate_limited'].includes(scnInfo)) {
      const fake = { http500: { status: 500, body: { error: 'Internal Server Error' } }, malformed: { status: 200, raw: '{"payout_id": "po_', type: 'application/json' }, html_error: { status: 502, raw: '<html>502</html>', type: 'text/html' }, rate_limited: { status: 429, body: { error: 'Too Many Requests' } } }[scnInfo];
      return { scn: scnInfo, res: fake };
    }
    const need = ['mandate_id', 'amount_paise', 'payee_vpa', 'obligation_id'];
    const miss = need.filter((k) => a[k] == null || a[k] === '');
    if (miss.length) return { scn: scnInfo, res: { status: 400, body: { error: `missing ${miss.join(', ')}` } } };
    if (!a.proof?.tradesman_msg_id || !a.proof?.tenant_confirm_msg_id) {
      return { scn: scnInfo, res: { status: 422, body: { error: 'proof_required', detail: 'Payout needs proof.tradesman_msg_id (photo of the fix) and proof.tenant_confirm_msg_id (tenant confirmed)' } } };
    }
    if (!Number.isInteger(a.amount_paise) || a.amount_paise <= 0) return { scn: scnInfo, res: { status: 400, body: { error: 'amount_paise must be a positive integer' } } };
    if (a.amount_paise > config.grantMaxTxnPaise) {
      return { scn: scnInfo, res: { status: 403, body: { error: 'exceeds_grant', detail: `Grant scope mpp:payment:max_txn_paise:${config.grantMaxTxnPaise} is below ${a.amount_paise}. Ask the owner to pay by payment link.` } } };
    }
    const m = await kv.get(M(a.mandate_id));
    if (!m || m.status !== 'ACTIVE' || scnInfo === 'mandate_inactive') return { scn: scnInfo, res: { status: 409, body: { error: 'mandate_inactive', detail: `Mandate ${a.mandate_id} is not ACTIVE` } } };
    const remaining = scnInfo === 'insufficient_balance' ? 0 : m.amount - m.debited;
    if (remaining < a.amount_paise) return { scn: scnInfo, res: { status: 402, body: { error: 'insufficient_balance', amount_remaining: remaining } } };
    if (scnInfo === 'payee_mismatch') return { scn: scnInfo, res: { status: 409, body: { error: 'payee_name_mismatch', detail: `UPI name for ${a.payee_vpa} does not match ${a.payee_name || 'the tradesman on record'}` } } };
    m.debited += a.amount_paise; await kv.set(M(m.authorizationId), m);
    const payout = {
      payout_id: `po_${Date.now().toString(36)}`, idempotency_key: idemKey, obligation_id: a.obligation_id,
      amount_paise: a.amount_paise, payee_vpa: a.payee_vpa, payee_name_verified: true,
      status: scnInfo === 'payout_pending' ? 'PENDING' : 'SUCCESS',
      utr: scnInfo === 'payout_pending' ? null : utr(), created_at: await nowIST(), mandate_id: m.authorizationId,
    };
    await kv.set(P(idemKey), payout);
    if (scnInfo === 'timeout') { await sleep(timeoutMs()); return { scn: scnInfo, res: { status: 504, raw: '<html><body>504 Gateway Time-out</body></html>', type: 'text/html' } }; }
    return { scn: scnInfo, res: { status: 201, body: payout } };
  },

  async payoutStatus(idemKey) {
    const { scn, override } = await common('caps.payout_status');
    if (override) return { scn, res: override };
    const p = await kv.get(P(idemKey));
    if (!p) return { scn, res: { status: 404, body: { error: 'not_found', detail: `no payout with idempotency key ${idemKey}` } } };
    if (p.status === 'PENDING') { p.status = 'SUCCESS'; p.utr = utr(); await kv.set(P(idemKey), p); }
    return { scn, res: { status: 200, body: p } };
  },

  async splitDebit(a) {
    const { scn, override } = await common('caps.split');
    if (override) return { scn, res: override };
    const parts = a.mandates || [];
    if (!parts.length || !a.obligation_id) return { scn, res: { status: 400, body: { error: 'mandates[] and obligation_id are required' } } };
    const loaded = [];
    for (const p of parts) {
      const m = await kv.get(M(p.mandate_id));
      if (!m || m.status !== 'ACTIVE' || m.amount - m.debited < p.amount_paise || scn === 'insufficient_balance') {
        return { scn, res: { status: 409, body: { status: 'RELEASED', detail: `block failed on ${p.mandate_id}; every block released, nobody charged` } } };
      }
      loaded.push([m, p.amount_paise]);
    }
    for (const [m, amt] of loaded) { m.debited += amt; await kv.set(M(m.authorizationId), m); }
    return { scn, res: { status: 201, body: { status: 'DEBITED', obligation_id: a.obligation_id, debits: parts.map((p) => ({ ...p, utr: utr() })) } } };
  },

  async stock(pincode, sku) {
    const { scn, override } = await common('caps.stock');
    if (override) return { scn, res: override };
    if (!pincode || !sku) return { scn, res: { status: 400, body: { error: 'pincode and sku are required' } } };
    if (scn === 'out_of_stock') return { scn, res: { status: 200, body: { sku, in_stock: false, centres: [] } } };
    return { scn, res: { status: 200, body: { sku, in_stock: true, centres: [{ centre: 'BLR_Bommasandra_FC', seller_pickup_location: 'TENLY PARTS BLR', distance_km: 14, promised_date: 'next day' }] } } };
  },
};

// ---------------- REST routes ----------------
export function p3pRoutes(app) {
  const bearerOk = (c, key) => (c.req.header('authorization') || '') === `Bearer ${key}`;
  const apiKeyOk = (c) => c.req.header('x-api-key') === config.capsKey;
  const out = (conn, ep) => async (c, fn) => {
    const { scn, res } = await fn();
    await logCall(conn, ep, scn, res);
    return send(c, res);
  };
  app.post('/mpp/v1/mandates', async (c) => (bearerOk(c, config.p3pKey) ? out('p3p', 'createMandate')(c, async () => p3p.createMandate(await c.req.json().catch(() => ({})))) : c.json({ title: 'Unauthorized' }, 401)));
  app.get('/mpp/v1/balance', async (c) => (bearerOk(c, config.p3pKey) ? out('p3p', 'GET /mpp/v1/balance')(c, () => p3p.getMandateBalance({ authorizationId: c.req.query('authorizationId') })) : c.json({ title: 'Unauthorized' }, 401)));
  app.post('/mpp/v1/payments/decide', async (c) => (bearerOk(c, config.p3pKey) ? out('p3p', 'decidePayment')(c, async () => {
    const b = await c.req.json().catch(() => ({}));
    return p3p.decidePayment({ ...b, credential: c.req.header('p3p-credential'), grantex_token: c.req.header('x-grantex-token') });
  }) : c.json({ title: 'Unauthorized' }, 401)));
  app.post('/mpp/v1/payouts/individual', async (c) => (apiKeyOk(c) ? out('tenly_caps', 'POST /mpp/v1/payouts/individual')(c, async () => caps.payoutIndividual(await c.req.json().catch(() => ({})), c.req.header('idempotency-key'))) : c.json({ error: 'unauthorized' }, 401)));
  app.get('/mpp/v1/payouts/:key', async (c) => (apiKeyOk(c) ? out('tenly_caps', 'GET /mpp/v1/payouts/{key}')(c, () => caps.payoutStatus(c.req.param('key'))) : c.json({ error: 'unauthorized' }, 401)));
  app.post('/mpp/v1/mandates/split-debit', async (c) => (apiKeyOk(c) ? out('tenly_caps', 'POST /mpp/v1/mandates/split-debit')(c, async () => caps.splitDebit(await c.req.json().catch(() => ({})))) : c.json({ error: 'unauthorized' }, 401)));
  app.get('/api/v1/fulfillment/stock', async (c) => (apiKeyOk(c) ? out('tenly_caps', 'GET /api/v1/fulfillment/stock')(c, () => caps.stock(c.req.query('pincode'), c.req.query('sku'))) : c.json({ error: 'unauthorized' }, 401)));
}

// ---------------- MCP tools ----------------
const t = (conn, endpoint, fn, ref) => async (args) => {
  const { scn, res } = await fn(args);
  await logCall(conn, endpoint, scn, res, { obligation_id: args.obligation_id || '', external_ref: ref ? ref(res) : '' });
  return asTool(endpoint, res);
};

export const p3pTools = [
  {
    name: 'createMandate',
    description: 'Pine Labs P3P createMandate(): creates a UPI ReservePay / OTM mandate or card pre-authorisation. amount is in paise. Returns deep_link (UPI) or checkout_url (card); status stays PENDING until the customer approves in their UPI app.',
    inputSchema: { type: 'object', properties: { customerReference: { type: 'string' }, mobileNumber: { type: 'string' }, amount: { type: 'integer', description: 'paise' }, paymentMethod: { type: 'string', enum: METHODS } }, required: ['customerReference', 'mobileNumber', 'amount', 'paymentMethod'] },
    handler: t('tenly_p3p', 'createMandate', (a) => p3p.createMandate(a)),
  },
  {
    name: 'getMandateBalance',
    description: 'Pine Labs P3P getMandateBalance() -> GET /mpp/v1/balance. Returns status (must be ACTIVE to pay), amount.value, balance_details.amount_debited.value and balance_details.amount_remaining.value, all in paise. Call this before every payout.',
    inputSchema: { type: 'object', properties: { authorizationId: { type: 'string', description: 'The mandate ID from the Tenancy row (mandate_id)' } }, required: ['authorizationId'] },
    handler: t('tenly_p3p', 'GET /mpp/v1/balance', (a) => p3p.getMandateBalance(a)),
  },
  {
    name: 'decidePayment',
    description: 'Pine Labs P3P decidePayment(): the 402 challenge -> credential -> capture cycle for a paid call. Without credential "Payment" and a Grantex token it returns 402 with WWW-Authenticate: Payment. With them it debits the mandate and returns Payment-Receipt.',
    inputSchema: { type: 'object', properties: { authorizationId: { type: 'string' }, amount_paise: { type: 'integer' }, credential: { type: 'string', description: 'P3P-Credential header value, "Payment"' }, grantex_token: { type: 'string', description: 'X-Grantex-Token header value' } }, required: ['authorizationId', 'amount_paise'] },
    handler: t('tenly_p3p', 'decidePayment', (a) => p3p.decidePayment(a)),
  },
];

export const capsTools = [
  {
    name: 'payout_individual',
    description: 'TENLY CAPABILITY (Pine Labs gap; P3P pays merchants only). POST /mpp/v1/payouts/individual: pays a verified individual UPI ID (the tradesman) from the owner\'s mandate. Refuses with 422 unless both proofs are given, 403 above the grant limit (Rs 4,000), 402 if the mandate balance is too low, 409 if the mandate is inactive or the payee name does not match. idempotency_key is required: use <obligation_id>-pay-<attempt>; the same key never pays twice. Success: status SUCCESS with utr; PENDING means check payout_status later.',
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: { type: 'string' }, mandate_id: { type: 'string' }, amount_paise: { type: 'integer' },
        payee_vpa: { type: 'string' }, payee_name: { type: 'string' }, obligation_id: { type: 'string' },
        proof_tradesman_msg_id: { type: 'string', description: 'WhatsApp message ID of the tradesman\'s photo of the fix' },
        proof_tenant_confirm_msg_id: { type: 'string', description: 'WhatsApp message ID of the tenant confirming the fix' },
      },
      required: ['idempotency_key', 'mandate_id', 'amount_paise', 'payee_vpa', 'obligation_id'],
    },
    handler: t('tenly_caps', 'POST /mpp/v1/payouts/individual', (a) => caps.payoutIndividual({
      mandate_id: a.mandate_id, amount_paise: a.amount_paise, payee_vpa: a.payee_vpa, payee_name: a.payee_name,
      obligation_id: a.obligation_id, proof: { tradesman_msg_id: a.proof_tradesman_msg_id, tenant_confirm_msg_id: a.proof_tenant_confirm_msg_id },
    }, a.idempotency_key), (res) => res.body?.utr || res.body?.payout_id || ''),
  },
  {
    name: 'payout_status',
    description: 'TENLY CAPABILITY. GET /mpp/v1/payouts/{idempotency_key}. Use after a timeout or a PENDING payout, BEFORE any retry: if it exists, it was paid (or is paying); never pay again.',
    inputSchema: { type: 'object', properties: { idempotency_key: { type: 'string' } }, required: ['idempotency_key'] },
    handler: t('tenly_caps', 'GET /mpp/v1/payouts/{key}', (a) => caps.payoutStatus(a.idempotency_key), (res) => res.body?.utr || ''),
  },
  {
    name: 'split_debit',
    description: 'TENLY CAPABILITY (Pine Labs gap; mandates are single-customer). POST /mpp/v1/mandates/split-debit: blocks each party\'s share via Reserve Pay and debits all together, or releases all. Use only when both parties agreed to split a repair.',
    inputSchema: { type: 'object', properties: { obligation_id: { type: 'string' }, mandates: { type: 'array', items: { type: 'object', properties: { mandate_id: { type: 'string' }, amount_paise: { type: 'integer' } } } } }, required: ['obligation_id', 'mandates'] },
    handler: t('tenly_caps', 'POST /mpp/v1/mandates/split-debit', (a) => caps.splitDebit(a)),
  },
  {
    name: 'fulfillment_stock',
    description: 'TENLY CAPABILITY (Delhivery gap). GET /api/v1/fulfillment/stock?pincode=&sku=: which Delhivery fulfilment centre near the flat stocks a spare part, and the seller pickup_location to use for create_shipment.',
    inputSchema: { type: 'object', properties: { pincode: { type: 'string' }, sku: { type: 'string', description: 'Part name or SKU, e.g. "tap cartridge 1/2 inch"' } }, required: ['pincode', 'sku'] },
    handler: t('tenly_caps', 'GET /api/v1/fulfillment/stock', (a) => caps.stock(a.pincode, a.sku)),
  },
];
