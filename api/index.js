// Vercel entry point: every path is rewritten here (see vercel.json).
import { handle } from 'hono/vercel';
import { app, boot } from '../src/app.js';

await boot();
export const config = { runtime: 'nodejs', maxDuration: 60 };
export default handle(app);
