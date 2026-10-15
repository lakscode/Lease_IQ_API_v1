// Runtime shims so the same code runs on Node (local, port 3000) and Supabase Edge Functions (Deno).
import { errorFields, log } from './log.ts';

type DenoLike = { env: { get(name: string): string | undefined } };
type EdgeRuntimeLike = { waitUntil(promise: Promise<unknown>): void };

const g = globalThis as unknown as {
  Deno?: DenoLike;
  EdgeRuntime?: EdgeRuntimeLike;
  process?: { env: Record<string, string | undefined> };
};

export const isEdgeRuntime = Boolean(g.Deno);

export function getEnv(name: string): string | undefined {
  const value = g.Deno ? g.Deno.env.get(name) : g.process?.env[name];
  return value === '' ? undefined : value;
}

/**
 * Keep work running after the response is sent.
 * Edge: EdgeRuntime.waitUntil keeps the isolate alive (up to the platform wall-clock limit).
 * Node: the process stays up, so the promise simply continues.
 */
export function runInBackground(task: () => Promise<unknown>): void {
  const promise = task().catch((err) => log.error('background', (err as Error)?.message || String(err), errorFields(err)));
  g.EdgeRuntime?.waitUntil(promise);
}

/** Wall-clock budget for background work in one invocation (Edge functions are cut off at ~400s). */
export const BACKGROUND_BUDGET_MS = isEdgeRuntime ? 300_000 : Number.POSITIVE_INFINITY;
