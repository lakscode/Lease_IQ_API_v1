// Lease IQ API — one Hono app shared by the Node server (src/server.ts) and the Supabase Edge Function (index.ts).
// Every route lives under /api. Routes are public only if listed in PUBLIC_PATHS; everything else is authenticated.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authenticate } from './lib/auth.ts';
import { env } from './lib/env.ts';
import { errorResponse } from './lib/http.ts';
import type { AppEnv } from './lib/types.ts';

import system from './routes/system.ts';
import me from './routes/me.ts';
import orgs from './routes/orgs.ts';
import invites from './routes/invites.ts';
import admin from './routes/admin.ts';
import usage from './routes/usage.ts';
import support from './routes/support.ts';
import files from './routes/files.ts';
import leases from './routes/leases.ts';
import attachments from './routes/attachments.ts';
import chat from './routes/chat.ts';
import insights from './routes/insights.ts';
import financial from './routes/financial.ts';
import dashboard from './routes/dashboard.ts';
import portfolio from './routes/portfolio.ts';
import reports from './routes/reports.ts';
import imports from './routes/imports.ts';
import clientErrors from './routes/client-errors.ts';
import logs from './routes/logs.ts';
import clauses from './routes/clauses.ts';
import fund from './routes/fund.ts';
import { log } from './lib/log.ts';
import { recordRequest } from './lib/api-request-log.ts';

/** Paths (relative to /api) that don't require a signed-in user. */
const PUBLIC_PATHS = [/^\/?$/, /^\/health$/, /^\/status$/, /^\/config$/, /^\/invites\/preview\//, /^\/client-errors$/, /^\/logs(\/api)?$/];

export function createApp() {
  const api = new Hono<AppEnv>();

  // One log line per request (method, path, status, duration, user, organization), also stored in
  // api_request_log for Logs → API logs.
  api.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.method === 'OPTIONS') return;
    const status = c.res.status;
    const ctx = {
      method: c.req.method, path: c.req.path, status, ms: Date.now() - started,
      userId: (c.get('user') as { id?: string } | undefined)?.id ?? null,
      orgId: (c.get('orgId') as string | undefined) ?? null,
    };
    // 5xx are logged as errors by errorResponse (with the cause); here only the access line.
    log.info('http', `${c.req.method} ${c.req.path} ${status} ${ctx.ms}ms`, ctx);
    recordRequest(c, started);
  });

  api.use('*', async (c, next) => {
    const sub = c.req.path.replace(/^\/api/, '') || '/';
    if (c.req.method === 'OPTIONS' || PUBLIC_PATHS.some((re) => re.test(sub))) return next();
    return authenticate(c, next);
  });

  api.route('/', system);
  api.route('/me', me);
  api.route('/orgs', orgs);
  api.route('/invites', invites);
  api.route('/admin', admin);
  api.route('/usage', usage);
  api.route('/support', support);
  api.route('/files', files);
  api.route('/leases', leases);
  api.route('/', attachments);   // /leases/:id/attachments, /attachments/:id
  api.route('/chat', chat);
  api.route('/', insights);      // /leases/:id/insights, /opportunities
  api.route('/', financial);     // /leases/:id/rent-audit, /leases/:id/cam, /market-rates
  api.route('/dashboard', dashboard);
  api.route('/portfolio', portfolio);
  api.route('/reports', reports);
  api.route('/imports', imports);
  api.route('/clauses', clauses);   // SVM clause prediction
  api.route('/fund', fund);         // fund administration (+ routes/fund-transactions.ts)
  api.route('/client-errors', clientErrors);
  api.route('/logs', logs);         // /logs, /logs/api — check their own auth (super admin or LOGS_API_TOKEN)

  const app = new Hono<AppEnv>();
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (env.corsOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Authorization', 'Content-Type', 'X-Org-Id', 'apikey', 'x-client-info'],
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['Content-Disposition'],
      maxAge: 600,
    }),
  );
  app.route('/api', api);
  app.notFound((c) => c.json({ error: 'Not found', code: 'not_found' }, 404));
  app.onError(errorResponse);
  return app;
}
