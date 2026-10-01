// tenly-rails: one app, six MCP servers, REST mocks with exact provider paths, the WhatsApp relay,
// media, and an admin console for testers (scenarios, demo clock, reset, logs).
import { Hono } from 'hono';
import { config } from './lib/config.js';
import { mcpServer } from './lib/mcp.js';
import { kv } from './lib/kv.js';
import { advance, resetClock, nowIST } from './lib/clock.js';
import { setScenario, clearScenarios, SCENARIOS, ENDPOINTS } from './lib/scenario.js';
import { mediaRoutes, putBytes } from './lib/media.js';
import { resetLedger, getLedger } from './ledger/index.js';
import { delhiveryRoutes, delhiveryTools } from './rails/delhivery.js';
import { p3pRoutes, p3pTools, capsTools, seedMandates, p3p } from './rails/p3p.js';
import { gnaniTools } from './rails/gnani.js';
import { waTools, outbox } from './rails/whatsapp.js';
import { sheetsTools } from './rails/sheets.js';
import { relayRoutes, handleMessage } from './relay.js';
import { consoleHtml } from './console.js';

export const app = new Hono();

// Request log for MCP endpoints (headers redacted) - visible in Vercel runtime logs and /mock/mcplog.
app.use('/mcp/*', async (c, next) => {
  const t0 = Date.now();
  let body = '';
  try { body = (await c.req.raw.clone().text()).slice(0, 300); } catch { /* ignore */ }
  const h = Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k, /key|auth|token|cookie/i.test(k) ? `${v.slice(0, 4)}…(${v.length})` : v.slice(0, 120)]));
  await next();
  const rec = { at: new Date().toISOString(), method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - t0, headers: h, body };
  console.log('mcp', JSON.stringify(rec));
  try { await kv.lpushCapped('tenly:mcplog', rec, 200); } catch { /* ignore */ }
});

const SERVERS = {
  sheets: { name: 'tenly_sheets', key: () => config.mcpKeys.sheets, tools: sheetsTools, instructions: 'TenLy shared tenancy record (Google Sheets). Read before acting; write every state change and decision.' },
  gnani: { name: 'tenly_gnani', key: () => config.mcpKeys.gnani, tools: gnaniTools, instructions: 'Gnani STT/TTS. Every voice input and voice reply goes through these tools.' },
  'wa-ui': { name: 'tenly_wa_ui', key: () => config.mcpKeys.waui, tools: waTools, instructions: 'WhatsApp Cloud API: text, reply buttons, media. Only tenancy parties, only in call hours.' },
  delhivery: { name: 'tenly_delhivery', key: () => config.mcpKeys.delhivery, tools: delhiveryTools, instructions: 'Delhivery Express API (mock with the real endpoint names) for spare parts.' },
  p3p: { name: 'tenly_p3p', key: () => config.mcpKeys.p3p, tools: p3pTools, instructions: 'Pine Labs P3P (mock with the real method names): mandates, balance, 402 payment decision.' },
  caps: { name: 'tenly_caps', key: () => config.mcpKeys.caps, tools: capsTools, instructions: 'TenLy capabilities the rails lack today: individual payout, payout status, split debit, parts stock.' },
};
for (const [path, s] of Object.entries(SERVERS)) {
  app.all(`/mcp/${path}`, mcpServer({ name: s.name, version: '1.0.0', apiKey: s.key, tools: s.tools, instructions: s.instructions }));
}

delhiveryRoutes(app);
p3pRoutes(app);
relayRoutes(app);
mediaRoutes(app);

app.get('/', (c) => c.json({ service: 'tenly-rails', mode: config.mode, mcp: Object.keys(SERVERS).map((p) => `${config.baseUrl}/mcp/${p}`) }));
app.get('/health', async (c) => c.json({ ok: true, mode: config.mode, now_ist: await nowIST(), ledger: (await getLedger()).kind }));

// ---- Admin console (testers only; never registered as an agent tool) ----
const admin = (c) => c.req.header('x-admin-key') === config.adminKey;
app.use('/mock/*', async (c, next) => (admin(c) || c.req.path.startsWith('/mock/approve-mandate') ? next() : c.json({ error: 'admin key required' }, 401)));
app.post('/mock/scenario', async (c) => {
  const { endpoint, scenario, times = 1 } = await c.req.json();
  try { await setScenario(endpoint, scenario, times); } catch (e) { return c.json({ error: e.message, endpoints: ENDPOINTS, scenarios: SCENARIOS }, 400); }
  return c.json({ ok: true, endpoint, scenario, times });
});
app.post('/mock/reset', async (c) => {
  await clearScenarios(); await resetClock();
  for (const p of ['tenly:dlv:', 'tenly:payout:', 'tenly:p3p:', 'tenly:dedupe:', 'tenly:wa:', 'tenly:lock:', 'tenly:auditlog', 'tenly:lastin:']) await kv.flushPrefix(p);
  await seedMandates();
  await resetLedger();
  return c.json({ ok: true, now_ist: await nowIST() });
});
app.post('/mock/clock', async (c) => { const { advance_minutes } = await c.req.json(); await advance(Number(advance_minutes || 0)); return c.json({ now_ist: await nowIST() }); });
app.get('/mock/log', async (c) => c.json(await kv.lrange('tenly:auditlog', Number(c.req.query('n') || 100))));
app.get('/mock/mcplog', async (c) => c.json(await kv.lrange('tenly:mcplog', Number(c.req.query('n') || 30))));
app.get('/mock/outbox', async (c) => c.json(await outbox(Number(c.req.query('n') || 50))));
app.get('/mock/ledger', async (c) => { const l = await getLedger(); const out = {}; for (const t of ['Tenancy', 'Parties', 'Obligations', 'Inbox', 'Config', 'Audit']) out[t] = await l.read(t); return c.json(out); });
app.post('/mock/fixture/stt', async (c) => { const { media_key, transcript } = await c.req.json(); await kv.set(`tenly:fixture:stt:${media_key}`, { transcript }); return c.json({ ok: true }); });
app.post('/mock/media', async (c) => { const { b64, mime } = await c.req.json(); return c.json(await putBytes(Buffer.from(b64, 'base64'), mime || 'application/octet-stream')); });
// Simulate an inbound WhatsApp from a party without a live number (owner, tradesman) - testers only.
app.post('/mock/inbound', async (c) => {
  const b = await c.req.json();
  const l = await getLedger();
  const party = (await l.read('Parties')).find((p) => p.msisdn === b.msisdn || p.role === b.role);
  if (!party) return c.json({ error: 'no such party' }, 400);
  const id = `wamid.SIMIN${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const m = { id, from: party.msisdn, type: b.type || 'text' };
  if (m.type === 'text') m.text = { body: b.text || '' };
  if (m.type === 'button') { m.type = 'interactive'; m.interactive = { button_reply: { id: b.button_id, title: b.text || b.button_id } }; }
  if (m.type === 'image') { m.image = { caption: b.text || '' }; }
  const res = await handleMessage(m);
  if (m.type === 'image' && res.event) {
    // Simulated photo: point the agent at a real image file.
    const url = `${config.baseUrl}/sample/fixed-tap.svg`;
    await l.updateWhere('Inbox', { event_id: id }, { media_url: url });
    res.event.media_url = url;
  }
  return c.json(res);
});
app.get('/sample/fixed-tap.svg', (c) => c.body('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#e8f4f8"/><text x="20" y="100" font-size="20">Kitchen tap - cartridge replaced, no leak</text></svg>', 200, { 'content-type': 'image/svg+xml' }));
app.get('/console', (c) => c.html(consoleHtml()));
app.get('/mock/approve-mandate/:id', async (c) => c.json({ approved: await p3p.approveMandate(c.req.param('id')) }));

// Seed mandates on cold start (idempotent; the reset endpoint re-seeds everything).
export async function boot() {
  if (!(await kv.get('tenly:p3p:mandate:MND-302'))) await seedMandates();
}
