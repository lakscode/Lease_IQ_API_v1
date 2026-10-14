// Errors reported by the browser (POST /client-errors). Public, because sign-up fails before anyone is signed in,
// so input is validated, size-capped and throttled per IP. Always answers 202 so the UI never has to handle a failure here.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { db } from '../lib/supabase.ts';
import { logError } from '../lib/error-log.ts';
import { str } from '../lib/http.ts';

const router = new Hono<AppEnv>();

const AREA_RE = /^[a-z][a-z0-9_.-]{1,59}$/;
const MAX_BODY = 8_000;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, { count: number; start: number }>();

function throttled(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW_MS) {
    if (hits.size > 5_000) hits.clear();
    hits.set(ip, { count: 1, start: now });
    return false;
  }
  return ++h.count > MAX_PER_WINDOW;
}

router.post('/', async (c) => {
  const accepted = () => c.json({ ok: true }, 202);
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (throttled(ip)) return accepted();

  const raw = await c.req.text().catch(() => '');
  if (!raw || raw.length > MAX_BODY) return accepted();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return accepted();
  }

  const area = str(body.area);
  const message = str(body.message);
  if (!area || !AREA_RE.test(area) || !message) return accepted();

  // Attach the user when the report comes from a signed-in session.
  let userId: string | null = null;
  const auth = c.req.header('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const { data } = await db().auth.getUser(auth.slice(7)).catch(() => ({ data: null }));
    userId = data?.user?.id ?? null;
  }

  const details = body.details && typeof body.details === 'object' && !Array.isArray(body.details)
    ? body.details as Record<string, unknown>
    : null;

  await logError({
    source: 'ui',
    area,
    level: body.level === 'warning' ? 'warning' : 'error',
    code: str(body.code),
    message,
    details,
    userId,
    email: str(body.email),
    path: str(body.path),
    userAgent: c.req.header('User-Agent') ?? null,
  });
  return accepted();
});

export default router;
