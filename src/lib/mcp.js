// Minimal, dependency-free MCP server over Streamable HTTP (stateless, JSON responses).
// AgenticOrg's custom connectors discover tools only through MCP, so every rail and wrapper
// is exposed this way. Tested against the official @modelcontextprotocol/sdk client.
import { audit } from './audit.js';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

function checkArgs(schema, args) {
  if (!schema || schema.type !== 'object') return null;
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const k of schema.required || []) {
    if (args[k] === undefined || args[k] === null || args[k] === '') return `missing required argument: ${k}`;
  }
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties?.[k];
    if (!p) {
      if (schema.additionalProperties === false) return `unknown argument: ${k}`;
      continue;
    }
    const t = p.type;
    const ok = !t
      || (t === 'string' && typeof v === 'string')
      || (t === 'integer' && Number.isInteger(v))
      || (t === 'number' && typeof v === 'number')
      || (t === 'boolean' && typeof v === 'boolean')
      || (t === 'array' && Array.isArray(v))
      || (t === 'object' && v && typeof v === 'object' && !Array.isArray(v));
    if (!ok) return `argument ${k} must be ${t}`;
    if (p.enum && !p.enum.includes(v)) return `argument ${k} must be one of ${p.enum.join(', ')}`;
  }
  return null;
}

// Some MCP clients (AgenticOrg among them) hand the model an empty argument schema, so the model
// sends free text or JSON inside one field such as "query". Recover the intended arguments.
const WRAPPERS = ['query', 'input', 'args', 'arguments', 'params', 'json', 'payload', 'request', 'kwargs'];
export function normaliseArgs(args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = { query: a }; } }
  if (a == null || typeof a !== 'object' || Array.isArray(a)) return a;
  for (const k of WRAPPERS) {
    const v = a[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) { const { [k]: _, ...rest } = a; a = { ...rest, ...v }; continue; }
    if (typeof v === 'string' && /^\s*[{[]/.test(v)) {
      try { const j = JSON.parse(v); if (j && typeof j === 'object' && !Array.isArray(j)) { const { [k]: _, ...rest } = a; a = { ...rest, ...j }; } } catch { /* keep as text */ }
    }
  }
  // Values that are JSON text for object/array arguments (e.g. rows: "[{...}]").
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === 'string' && /^\s*[{[]/.test(v)) { try { a[k] = JSON.parse(v); } catch { /* leave */ } }
  }
  return a;
}

// Spell the arguments out in the description too, for clients that drop inputSchema.
function describe(t) {
  const sc = t.inputSchema || {};
  const req = new Set(sc.required || []);
  const parts = Object.entries(sc.properties || {}).map(([k, p]) => `${k}${req.has(k) ? '' : '?'}: ${p.enum ? p.enum.join('|') : (p.type || 'any')}`);
  if (!parts.length) return t.description;
  const ex = {};
  for (const [k, p] of Object.entries(sc.properties || {})) if (req.has(k)) ex[k] = p.enum ? p.enum[0] : p.type === 'object' ? {} : p.type === 'array' ? [] : p.type === 'integer' ? 0 : '...';
  return `${t.description} ARGUMENTS (pass as named JSON fields, not free text): {${parts.join(', ')}}. Example: ${JSON.stringify(ex)}`;
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * @param {object} def { name, version, apiKey: () => string, instructions, tools: [{name, description, inputSchema, handler}] }
 * @returns Hono handler (c) => Response
 */
export function mcpServer(def) {
  const byName = new Map(def.tools.map((t) => [t.name, t]));

  async function handleOne(msg, ctx) {
    const { id, method, params } = msg || {};
    if (msg?.jsonrpc !== '2.0' || typeof method !== 'string') {
      // A response or garbage from the client: nothing to answer.
      return id !== undefined && method === undefined ? null : rpcError(id, -32600, 'Invalid Request');
    }
    const isNotification = id === undefined;
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: def.name, version: def.version || '1.0.0' },
            instructions: def.instructions,
          },
        };
      }
      case 'ping': return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0', id,
          result: {
            tools: def.tools.map((t) => ({
              name: t.name, description: describe(t), inputSchema: t.inputSchema,
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
          },
        };
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        let args = normaliseArgs(params?.arguments ?? {});
        if (tool.coerce) args = tool.coerce(args);
        const bad = checkArgs(tool.inputSchema, args);
        if (bad) {
          await audit({ actor: 'mcp', source_connector: def.name, action: `${tool.name} refused`, result: bad });
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: bad }) }], isError: true } };
        }
        try {
          const out = await tool.handler(args, ctx);
          const isError = Boolean(out && out.__isError);
          if (out && out.__isError) delete out.__isError;
          return {
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(out) }],
              structuredContent: out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out },
              isError,
            },
          };
        } catch (e) {
          await audit({ actor: 'mcp', source_connector: def.name, action: `${tool.name} failed`, result: String(e.message || e) });
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: String(e.message || e) }) }], isError: true } };
        }
      }
      default:
        if (isNotification || method.startsWith('notifications/')) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return async (c) => {
    if (c.req.method === 'GET' || c.req.method === 'DELETE') {
      return c.text('Method Not Allowed: this server is stateless and does not open an SSE stream', 405, { Allow: 'POST' });
    }
    const key = c.req.header('x-api-key') || (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!key || key !== def.apiKey()) return c.json(rpcError(null, -32001, 'Unauthorized'), 401);
    let body;
    try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, 'Parse error'), 400); }
    const ctx = { server: def.name };
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleOne(m, ctx)))).filter(Boolean);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handleOne(body, ctx);
    return out ? c.json(out) : c.body(null, 202);
  };
}

// Tool results that should be flagged as errors to the agent (still a normal JSON body).
export const toolError = (obj) => ({ ...obj, __isError: true });
