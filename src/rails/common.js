// Shared behaviour for every mocked endpoint: scripted failures that must look like the real
// thing (a hang, a 500, truncated JSON, an HTML error page, a 429).
import { takeScenario, sleep, timeoutMs } from '../lib/scenario.js';
import { audit } from '../lib/audit.js';

export async function common(endpointKey) {
  const scn = await takeScenario(endpointKey);
  switch (scn) {
    case 'timeout': await sleep(timeoutMs()); return { scn, override: { status: 504, raw: '<html><body><h1>504 Gateway Time-out</h1></body></html>', type: 'text/html' } };
    case 'http500': return { scn, override: { status: 500, body: { error: 'Internal Server Error', request_id: rid() } } };
    case 'malformed': return { scn, override: { status: 200, raw: '{"success": true, "packages": [{"waybill": "13', type: 'application/json' } };
    case 'html_error': return { scn, override: { status: 502, raw: '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', type: 'text/html' } };
    case 'rate_limited': return { scn, override: { status: 429, body: { error: 'Too Many Requests' }, headers: { 'Retry-After': '30' } } };
    default: return { scn, override: null };
  }
}

export const rid = () => `req_${Math.random().toString(36).slice(2, 10)}`;

// Send a mock result over REST.
export function send(c, res) {
  const headers = res.headers || {};
  if (res.raw !== undefined) return c.body(res.raw, res.status, { 'Content-Type': res.type || 'text/plain', ...headers });
  return c.json(res.body, res.status, headers);
}

// Shape a mock result for an MCP tool: the provider's body unchanged plus the HTTP status.
export function asTool(endpoint, res) {
  let body = res.body;
  if (res.raw !== undefined) body = res.raw;
  const out = { endpoint, http_status: res.status, body };
  if (res.headers) out.headers = res.headers;
  if (res.status >= 400 || res.raw !== undefined) out.__isError = res.status >= 400;
  return out;
}

export async function logCall(connector, endpoint, scn, res, extra = {}) {
  await audit({
    actor: 'mock', source_connector: connector, action: endpoint,
    input_summary: scn === 'ok' ? '' : `scenario=${scn}`,
    result: `http ${res.status}`, ...extra,
  });
}

export function authToken(c, expected, scheme = 'Token') {
  const h = c.req.header('authorization') || '';
  return h === `${scheme} ${expected}`;
}
