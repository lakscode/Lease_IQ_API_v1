// Supabase Edge Function entry point. Deployed as `api`, so requests arrive as /api/...
// Deploy with `npm run deploy:supabase` (JWT verification is done by the app, not the gateway).
import { createApp } from './app.ts';

Deno.serve(createApp().fetch);
