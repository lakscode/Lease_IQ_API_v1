import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';

// TODO: implemented by the feature owner (see API/docs/CONTRACT.md).
const router = new Hono<AppEnv>();

export default router;
