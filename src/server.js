// Local server: `npm run dev` (PORT defaults to 8787).
import { serve } from '@hono/node-server';
import { app, boot } from './app.js';

const port = Number(process.env.PORT || 8787);
await boot();
export const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`tenly-rails listening on http://localhost:${info.port} (mode=${process.env.TENLY_MODE || 'local'})`);
});
