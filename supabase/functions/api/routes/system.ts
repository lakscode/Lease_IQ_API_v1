import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { getSystemStatus } from '../lib/health.ts';
import { aiConfigured } from '../lib/ai.ts';
import { emailConfigured } from '../lib/email.ts';
import { env } from '../lib/env.ts';

const router = new Hono<AppEnv>();

// GET /api — JSON status (the Node server also serves an HTML page at /).
router.get('/', async (c) => {
  const status = await getSystemStatus();
  return c.json(status, status.status === 'ok' ? 200 : 503);
});

router.get('/health', (c) => c.json({ status: 'ok' }));

router.get('/status', async (c) => {
  const status = await getSystemStatus();
  return c.json(status, status.status === 'ok' ? 200 : 503);
});

// Public feature flags for the UI (no secrets).
router.get('/config', async (c) => {
  const j = env.jira;
  return c.json({
    ai: aiConfigured(),
    email: await emailConfigured(),
    jira: Boolean(j.baseUrl && j.email && j.apiToken && j.projectKey),
    maxUploadMb: env.maxUploadMb,
  });
});

export default router;
