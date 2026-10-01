// Vercel entry point (Node.js runtime): every path is rewritten here (see vercel.json).
// The Node runtime passes (req, res), so use the node-server adapter, not hono/vercel (Edge).
import { handle } from '@hono/node-server/vercel';
import { app, boot } from '../src/app.js';

export const config = { maxDuration: 60 };

let booted;
const handler = handle(app);
export default async function (req, res) {
  booted ??= boot().catch((e) => { booted = undefined; console.error('boot failed', e); });
  await booted;
  return handler(req, res);
}
