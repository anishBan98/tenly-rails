// Delhivery Express API mock. Paths and field names follow Delhivery's Express API docs
// (https://delhivery-express-api-doc.readme.io). State (waybills) lives in KV so tracking moves
// forward call by call. Auth: header "Authorization: Token <DLV_MOCK_KEY>".
import { kv } from '../lib/kv.js';
import { config } from '../lib/config.js';
import { nowIST } from '../lib/clock.js';
import { common, send, asTool, logCall, authToken } from './common.js';

// Serviceable: Bengaluru urban pincodes 560001-560110. Everything else is a non-serviceable zone.
const serviceable = (pin) => /^560\d{3}$/.test(pin) && Number(pin) <= 560110;
const STEPS = [
  { Status: 'Manifested', StatusType: 'UD', Instructions: 'Shipment manifested' },
  { Status: 'In Transit', StatusType: 'UD', Instructions: 'Shipment picked up' },
  { Status: 'Dispatched', StatusType: 'UD', Instructions: 'Out for delivery' },
  { Status: 'Delivered', StatusType: 'DL', Instructions: 'Delivered to consignee' },
];

export const core = {
  async pincode(filterCodes) {
    const { scn, override } = await common('dlv.pincode');
    if (override) return { scn, res: override };
    const pins = String(filterCodes || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!pins.length) return { scn, res: { status: 400, body: { error: 'filter_codes is required' } } };
    if (scn === 'not_serviceable') return { scn, res: { status: 200, body: { delivery_codes: [] } } };
    const codes = pins.filter((p) => serviceable(p) && scn !== 'nsz').map((pin) => ({
      postal_code: {
        district: 'Bangalore', pin: Number(pin), max_amount: 0, pre_paid: 'Y', cash: 'Y', pickup: 'Y',
        repl: 'Y', cod: 'Y', country_code: 'IN', sort_code: 'BLR/KRM', is_oda: 'N', state_code: 'KA',
        max_weight: 0, remarks: '',
      },
    }));
    if (scn === 'nsz') return { scn, res: { status: 200, body: { delivery_codes: pins.map((p) => ({ postal_code: { pin: Number(p), pre_paid: 'N', cash: 'N', pickup: 'N', remarks: 'NSZ' } })) } } };
    return { scn, res: { status: 200, body: { delivery_codes: codes } } };
  },

  async create(data) {
    const { scn, override } = await common('dlv.create');
    if (override) return { scn, res: override };
    const shipments = data?.shipments;
    if (!Array.isArray(shipments) || !shipments.length) {
      return { scn, res: { status: 200, body: { success: false, rmk: 'An internal Error has occurred, Please get in touch with client.support@delhivery.com', packages: [] } } };
    }
    if (!data.pickup_location?.name) {
      return { scn, res: { status: 200, body: { success: false, rmk: 'ClientWarehouse matching query does not exist.', packages: [] } } };
    }
    if (scn === 'shipment_rejected') {
      return { scn, res: { status: 200, body: { success: false, rmk: 'Shipment rejected: consignee pincode not serviceable for prepaid', packages: [{ status: 'Fail', waybill: '', refnum: shipments[0].order, remarks: ['Non-serviceable pincode'] }] } } };
    }
    const packages = [];
    for (const s of shipments) {
      if (!s.pin || !s.order || !s.name || !s.add) {
        packages.push({ status: 'Fail', waybill: '', refnum: s.order || '', remarks: ['name, add, pin and order are mandatory'], serviceable: false });
        continue;
      }
      if (!serviceable(String(s.pin))) { packages.push({ status: 'Fail', waybill: '', refnum: s.order, remarks: ['Non-serviceable pincode'], serviceable: false }); continue; }
      const waybill = String(1490000000000 + (await kv.incr('tenly:dlv:seq')));
      await kv.set(`tenly:dlv:wb:${waybill}`, { waybill, order: s.order, pin: String(s.pin), step: 0, fast: false, cancelled: false, created: await nowIST(), products_desc: s.products_desc || '' });
      packages.push({ status: 'Success', client: 'TENLY SURFACE', sort_code: 'BLR/KRM', remarks: [], waybill, cod_amount: 0, payment: 'Pre-paid', serviceable: true, refnum: s.order });
    }
    const ok = packages.every((p) => p.status === 'Success');
    return { scn, res: { status: 200, body: { cash_pickups_count: 0, package_count: packages.length, upload_wbn: `UPL${Date.now()}`, replacement_count: 0, rmk: ok ? '' : 'Some packages failed', pickups_count: 0, packages, cash_pickups: 0, cod_count: 0, success: ok, prepaid_count: packages.length, cod_amount: 0 } } };
  },

  async pickup(body) {
    const { scn, override } = await common('dlv.pickup');
    if (override) return { scn, res: override };
    if (!body?.pickup_location || !body?.pickup_date || !body?.pickup_time) return { scn, res: { status: 400, body: { error: 'pickup_location, pickup_date and pickup_time are required' } } };
    if (scn === 'no_pickup_slot') return { scn, res: { status: 200, body: { pr_exist: false, error: true, message: 'No rider available for the requested pickup slot. Please choose another slot.' } } };
    return { scn, res: { status: 200, body: { pickup_location_name: body.pickup_location, client_name: 'TENLY SURFACE', pickup_time: body.pickup_time, pickup_id: 1000 + (await kv.incr('tenly:dlv:pick')), incoming_center_name: 'Bangalore_Koramangala_DC', expected_package_count: body.expected_package_count || 1, pickup_date: body.pickup_date } } };
  },

  async track(waybill) {
    const { scn, override } = await common('dlv.track');
    if (override) return { scn, res: override };
    const s = await kv.get(`tenly:dlv:wb:${waybill}`);
    if (!s) return { scn, res: { status: 200, body: { Error: 'No such waybill or Order Id found', ShipmentData: [] } } };
    if (!s.cancelled && s.step < STEPS.length - 1) {
      s.step = scn === 'fast' ? STEPS.length - 1 : s.step + 1;
    }
    let status = s.cancelled ? { Status: 'Cancelled', StatusType: 'CN', Instructions: 'Shipment cancelled by client' } : STEPS[s.step];
    if (scn === 'undelivered_ndr' && !s.cancelled) {
      s.step = 2; status = { Status: 'Undelivered', StatusType: 'UD', Instructions: 'Consignee unavailable - NDR raised', NSLCode: 'EOD-11' };
      s.ndr = true;
    }
    await kv.set(`tenly:dlv:wb:${waybill}`, s);
    const at = await nowIST();
    return { scn, res: { status: 200, body: { ShipmentData: [{ Shipment: { AWB: waybill, ReferenceNo: s.order, Origin: 'Bangalore_Hub', Destination: `Bangalore_${s.pin}`, Status: { ...status, StatusDateTime: at, StatusLocation: 'Bangalore_Koramangala_DC' }, Scans: STEPS.slice(0, s.step + 1).map((st) => ({ ScanDetail: { Scan: st.Status, ScanType: st.StatusType, Instructions: st.Instructions } })) } }] } } };
  },

  async cancel(body) {
    const { scn, override } = await common('dlv.cancel');
    if (override) return { scn, res: override };
    const s = await kv.get(`tenly:dlv:wb:${body?.waybill}`);
    if (!s) return { scn, res: { status: 200, body: { status: false, waybill: body?.waybill, remark: 'Waybill not found' } } };
    if (scn === 'cancel_after_delivery' || s.step === STEPS.length - 1) return { scn, res: { status: 200, body: { status: false, waybill: s.waybill, remark: 'Shipment already delivered, cannot be cancelled' } } };
    s.cancelled = true; await kv.set(`tenly:dlv:wb:${s.waybill}`, s);
    return { scn, res: { status: 200, body: { status: true, waybill: s.waybill, remark: 'Shipment has been cancelled.', order_id: s.order } } };
  },

  async ndr(body) {
    const { scn, override } = await common('dlv.ndr');
    if (override) return { scn, res: override };
    const items = body?.data;
    if (!Array.isArray(items) || !items.length) return { scn, res: { status: 400, body: { error: 'data must be a list of {waybill, act}' } } };
    for (const it of items) {
      const s = await kv.get(`tenly:dlv:wb:${it.waybill}`);
      if (s && it.act === 'RE-ATTEMPT') { s.step = 2; s.ndr = false; await kv.set(`tenly:dlv:wb:${s.waybill}`, s); }
    }
    return { scn, res: { status: 200, body: { request_id: `ndr_${Date.now()}`, status: 'true' } } };
  },
};

// ---- REST routes (exact Delhivery paths) ----
export function delhiveryRoutes(app) {
  const guard = (c) => authToken(c, config.dlvToken, 'Token');
  const wrap = (key, fn) => async (c) => {
    if (!guard(c)) return c.json({ detail: 'Authentication credentials were not provided.' }, 401);
    const { scn, res } = await fn(c);
    await logCall('delhivery', key, scn, res);
    return send(c, res);
  };
  app.get('/c/api/pin-codes/json/', wrap('GET /c/api/pin-codes/json/', (c) => core.pincode(c.req.query('filter_codes'))));
  app.post('/api/cmu/create.json', wrap('POST /api/cmu/create.json', async (c) => {
    const form = await c.req.parseBody();
    let data;
    try { data = JSON.parse(form.data || '{}'); } catch { return { scn: 'ok', res: { status: 400, body: { success: false, rmk: 'data is not valid JSON' } } }; }
    return core.create(data);
  }));
  app.post('/fm/request/new/', wrap('POST /fm/request/new/', async (c) => core.pickup(await c.req.json().catch(() => ({})))));
  app.get('/api/v1/packages/json/', wrap('GET /api/v1/packages/json/', (c) => core.track(c.req.query('waybill'))));
  app.post('/api/p/edit', wrap('POST /api/p/edit', async (c) => core.cancel(await c.req.json().catch(() => ({})))));
  app.post('/api/p/update', wrap('POST /api/p/update', async (c) => core.ndr(await c.req.json().catch(() => ({})))));
}

// ---- MCP tools (each names the exact endpoint it maps to) ----
const run = (endpoint, key, fn) => async (args) => {
  const { scn, res } = await fn(args);
  await logCall('tenly_delhivery', endpoint, scn, res, { actor: 'mock', external_ref: res.body?.packages?.[0]?.waybill || args.waybill || '' });
  return asTool(endpoint, res);
};

export const delhiveryTools = [
  {
    name: 'pincode_serviceability',
    description: 'Delhivery Pincode Serviceability API: GET /c/api/pin-codes/json/?filter_codes=<pincode>. Returns delivery_codes[].postal_code with pre_paid, cod and pickup flags. An empty delivery_codes list, or remarks "NSZ", means NOT serviceable.',
    inputSchema: { type: 'object', properties: { pincode: { type: 'string', description: '6-digit Indian pincode' } }, required: ['pincode'] },
    handler: run('GET /c/api/pin-codes/json/', 'dlv.pincode', (a) => core.pincode(a.pincode)),
  },
  {
    name: 'create_shipment',
    description: 'Delhivery Shipment Creation API: POST /api/cmu/create.json (form body format=json&data=<json>). Creates a prepaid shipment for a spare part from the seller to the flat. Success: success=true and packages[0].waybill. Check success and packages[].status; success=false means nothing was created.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Your reference, e.g. OB-17-part' },
        consignee_name: { type: 'string' }, address: { type: 'string' }, pincode: { type: 'string' },
        city: { type: 'string' }, state: { type: 'string' }, phone: { type: 'string' },
        products_desc: { type: 'string', description: 'e.g. Tap cartridge 1/2 inch' },
        weight_g: { type: 'number' }, pickup_location: { type: 'string', description: 'Registered seller warehouse name' },
      },
      required: ['order_id', 'consignee_name', 'address', 'pincode', 'products_desc', 'pickup_location'],
    },
    handler: run('POST /api/cmu/create.json', 'dlv.create', (a) => core.create({
      shipments: [{ name: a.consignee_name, add: a.address, pin: a.pincode, city: a.city || '', state: a.state || '', country: 'India', phone: a.phone || '', order: a.order_id, payment_mode: 'Prepaid', products_desc: a.products_desc, weight: a.weight_g || 200 }],
      pickup_location: { name: a.pickup_location },
    })),
  },
  {
    name: 'pickup_request',
    description: 'Delhivery Pickup Request API: POST /fm/request/new/. Books a rider pickup at the seller warehouse. A response with error=true (e.g. "No rider available") means no pickup was booked.',
    inputSchema: { type: 'object', properties: { pickup_location: { type: 'string' }, pickup_date: { type: 'string', description: 'YYYY-MM-DD' }, pickup_time: { type: 'string', description: 'HH:MM:SS' }, expected_package_count: { type: 'integer' } }, required: ['pickup_location', 'pickup_date', 'pickup_time'] },
    handler: run('POST /fm/request/new/', 'dlv.pickup', (a) => core.pickup(a)),
  },
  {
    name: 'track_shipment',
    description: 'Delhivery Tracking API: GET /api/v1/packages/json/?waybill=<waybill>. Read ShipmentData[0].Shipment.Status.Status: Manifested, In Transit, Dispatched, Delivered, Undelivered (NDR) or Cancelled.',
    inputSchema: { type: 'object', properties: { waybill: { type: 'string' } }, required: ['waybill'] },
    handler: run('GET /api/v1/packages/json/', 'dlv.track', (a) => core.track(a.waybill)),
  },
  {
    name: 'cancel_shipment',
    description: 'Delhivery Cancel API: POST /api/p/edit with {waybill, cancellation:"true"}. status=false means it could not be cancelled (e.g. already delivered).',
    inputSchema: { type: 'object', properties: { waybill: { type: 'string' } }, required: ['waybill'] },
    handler: run('POST /api/p/edit', 'dlv.cancel', (a) => core.cancel({ waybill: a.waybill, cancellation: 'true' })),
  },
  {
    name: 'ndr_action',
    description: 'Delhivery NDR API: POST /api/p/update with data=[{waybill, act}]. Use act "RE-ATTEMPT" after the tenant picks a new slot.',
    inputSchema: { type: 'object', properties: { waybill: { type: 'string' }, act: { type: 'string', enum: ['RE-ATTEMPT', 'DEFER_DLV'] } }, required: ['waybill', 'act'] },
    handler: run('POST /api/p/update', 'dlv.ndr', (a) => core.ndr({ data: [{ waybill: a.waybill, act: a.act }] })),
  },
];
