// Failure-scenario switch. A tester (never the agent) sets the next behaviour of an endpoint
// with POST /mock/scenario; the endpoint consumes it. "sticky" keeps it until reset.
import { kv } from './kv.js';

export const SCENARIOS = [
  'ok', 'fast', 'timeout', 'http500', 'malformed', 'html_error',
  'not_serviceable', 'nsz', 'shipment_rejected', 'no_pickup_slot', 'undelivered_ndr',
  'cancel_after_delivery', 'insufficient_balance', 'mandate_inactive', 'challenge_402',
  'payout_pending', 'payee_mismatch', 'out_of_stock', 'rate_limited', 'stt_empty',
];

export const ENDPOINTS = [
  'dlv.pincode', 'dlv.create', 'dlv.pickup', 'dlv.track', 'dlv.cancel', 'dlv.ndr',
  'p3p.create', 'p3p.balance', 'p3p.decide',
  'caps.payout', 'caps.payout_status', 'caps.split', 'caps.stock',
  'gnani.stt', 'gnani.tts', 'wa.send',
];

export async function setScenario(endpoint, scenario, times = 1) {
  if (!ENDPOINTS.includes(endpoint)) throw new Error(`unknown endpoint ${endpoint}`);
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario ${scenario}`);
  await kv.set(`tenly:scn:${endpoint}`, { scenario, times });
}

export async function takeScenario(endpoint) {
  const s = await kv.get(`tenly:scn:${endpoint}`);
  if (!s) return 'ok';
  if (s.times !== 'sticky') {
    const left = Number(s.times) - 1;
    if (left <= 0) await kv.del(`tenly:scn:${endpoint}`);
    else await kv.set(`tenly:scn:${endpoint}`, { ...s, times: left });
  }
  return s.scenario;
}

export async function clearScenarios() { await kv.flushPrefix('tenly:scn:'); }

// How long a "timeout" sleeps. AgenticOrg's MCP timeout is 60 s, so 65 s by default;
// tests shorten it.
export const timeoutMs = () => Number(process.env.MOCK_TIMEOUT_MS || 65000);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
