// Local Node server: runs the same Hono app as the Edge Function, on http://localhost:3000.
// GET / shows an HTML status page (Supabase serves function HTML as plain text, so it's Node-only).
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from '../supabase/functions/api/app.ts';
import { getSystemStatus } from '../supabase/functions/api/lib/health.ts';
import { renderLanding } from './landing.ts';
import { env } from '../supabase/functions/api/lib/env.ts';

const app = createApp();

app.get('/', async (c) => {
  const status = await getSystemStatus();
  return c.html(renderLanding(status, { uiUrl: env.appUrl }), status.status === 'ok' ? 200 : 503);
});

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`Lease IQ API listening on http://localhost:${port}`);
});
