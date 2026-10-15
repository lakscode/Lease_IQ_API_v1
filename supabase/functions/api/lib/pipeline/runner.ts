// Resumable lease-file pipeline. Steps are tracked in lease_files.steps; a worker holds lease_files.lock_until
// while it runs steps, so only one worker processes a file at a time. Steps:
//   prepare → ocr:A-B (scanned files only, ≤20 pages each) → split → abstract:N (one per document) → finalize
// A failed step stops the file (status failed + error); retry resumes from that step.
import type { AiContext, AiProcess } from '../ai.ts';
import { ApiError } from '../http.ts';
import { env } from '../env.ts';
import { BACKGROUND_BUDGET_MS, runInBackground } from '../runtime.ts';
import { db, must } from '../supabase.ts';
import { downloadBytes, removePaths, sha256Hex } from '../storage.ts';
import { recomputeLease } from '../lease-terms.ts';
import type { Locale } from '../types.ts';
import * as ai from './ai-steps.ts';
import {
  chunkPages, extractPageTexts, fitsAiPdfLimits, hasUsableText, isPdf, loadPdf, looksScanned, pagePreview, pagesNeedingOcr, subPdf,
} from './pdf.ts';
import {
  aiMode, applyAbstract, documentInput, leaseCandidates, loadFilePageTexts, normalizeSplit, previousMapping,
  removeFileDocuments, resolveLease, savePageTexts, saveSplit,
} from './store.ts';
import type { FileWork, LeaseFileRow, PipelineStep, SplitDocument } from './types.ts';
import { classifyDocumentClauses, orgClauseClassifier } from './clauses.ts';
import { errorFields, log } from '../log.ts';

/** How long a worker owns a file per step (a crashed worker's lock expires after this). */
export const LOCK_MS = 7 * 60_000;

/** The AI functions the pipeline uses — injectable so tests can run the whole pipeline without Claude. */
export interface PipelineAi {
  ocrPdf: typeof ai.ocrPdf;
  splitFile: typeof ai.splitFile;
  abstractDocument: typeof ai.abstractDocument;
}
const defaultAi: PipelineAi = { ocrPdf: ai.ocrPdf, splitFile: ai.splitFile, abstractDocument: ai.abstractDocument };

// ---- Rows, logs, locks --------------------------------------------------------------------------

export async function loadFile(fileId: string): Promise<LeaseFileRow> {
  const { data, error } = await db().from('lease_files').select('*').eq('id', fileId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ApiError('not_found', 'File not found');
  const row = data as LeaseFileRow;
  row.steps = Array.isArray(row.steps) ? row.steps : [];
  row.work = (row.work && typeof row.work === 'object' ? row.work : {}) as FileWork;
  return row;
}

async function saveFile(fileId: string, patch: Partial<LeaseFileRow> & Record<string, unknown>): Promise<void> {
  must(await db().from('lease_files').update(patch).eq('id', fileId), 'update file');
}

export async function logStep(file: { id: string; org_id: string }, step: string | null, message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  const { error } = await db().from('processing_logs').insert({ org_id: file.org_id, file_id: file.id, step, level, message: message.slice(0, 4000) });
  if (error) log.error('pipeline.log', `processing_logs insert failed: ${error.message}`, { fileId: file.id, step });
  // Step failures are logged separately as errors (with the cause) by runFile.
  log[level === 'warn' ? 'warn' : 'info']('pipeline', message.slice(0, 500), { fileId: file.id, orgId: file.org_id, step });
}

/** Take the file's lock if it is free (or expired). Returns false when another worker holds it. */
export async function claimLock(fileId: string): Promise<boolean> {
  const now = new Date();
  const { data, error } = await db()
    .from('lease_files')
    .update({ lock_until: new Date(now.getTime() + LOCK_MS).toISOString() })
    .eq('id', fileId)
    .in('status', ['queued', 'processing'])
    .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
    .select('id');
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

async function renewLock(fileId: string): Promise<void> {
  await saveFile(fileId, { lock_until: new Date(Date.now() + LOCK_MS).toISOString() });
}

export function isLocked(file: Pick<LeaseFileRow, 'lock_until'>): boolean {
  return Boolean(file.lock_until && Date.parse(file.lock_until) > Date.now());
}

function initialSteps(): PipelineStep[] {
  return [{ name: 'prepare', status: 'pending' }, { name: 'split', status: 'pending' }, { name: 'finalize', status: 'pending' }];
}

/** Insert steps right before the step called `before`. */
function insertSteps(steps: PipelineStep[], before: string, add: PipelineStep[]): PipelineStep[] {
  const names = new Set(steps.map((s) => s.name));
  const fresh = add.filter((s) => !names.has(s.name));
  const idx = steps.findIndex((s) => s.name === before);
  if (idx < 0) return [...steps, ...fresh];
  return [...steps.slice(0, idx), ...fresh, ...steps.slice(idx)];
}

async function uploaderLocale(userId: string | null): Promise<Locale> {
  if (!userId) return 'en';
  const { data } = await db().from('profiles').select('locale').eq('id', userId).maybeSingle();
  return ((data?.locale as Locale) ?? 'en');
}

function aiCtx(file: LeaseFileRow, process: AiProcess, leaseId?: string | null): AiContext {
  return { process, orgId: file.org_id, userId: file.uploaded_by, fileId: file.id, leaseId: leaseId ?? null };
}

function analysisProcess(file: LeaseFileRow): AiProcess {
  return file.work.mode === 'reanalysis' ? 'reanalysis' : 'analysis';
}

// ---- Step handlers --------------------------------------------------------------------------------

function withoutKey<T>(record: Record<string, T> | undefined, key: string): Record<string, T> | undefined {
  if (!record || !(key in record)) return record;
  const { [key]: _drop, ...rest } = record;
  return Object.keys(rest).length ? rest : undefined;
}

interface StepOutcome { detail: string; steps?: PipelineStep[]; work?: FileWork; patch?: Record<string, unknown> }

async function stepPrepare(file: LeaseFileRow): Promise<StepOutcome> {
  const bytes = await downloadBytes(file.storage_path);
  if (!isPdf(bytes)) throw new Error('The file is not a PDF.');
  if (bytes.length > env.maxUploadMb * 1024 * 1024) throw new Error(`The file is larger than ${env.maxUploadMb} MB.`);
  const sha256 = await sha256Hex(bytes);
  let pages: number;
  try {
    pages = (await loadPdf(bytes)).getPageCount();
  } catch (err) {
    throw new Error(`Could not read the PDF: ${(err as Error).message}`);
  }
  if (pages < 1) throw new Error('The PDF has no pages.');
  if (pages > 2000) throw new Error('The PDF has more than 2000 pages.');

  let texts: string[];
  try {
    texts = await extractPageTexts(bytes);
  } catch (err) {
    await logStep(file, 'prepare', `Text extraction failed (${(err as Error).message}); treating the file as scanned.`, 'warn');
    texts = [];
  }
  while (texts.length < pages) texts.push('');
  texts = texts.slice(0, pages);
  const scanned = looksScanned(texts);
  await savePageTexts(file, texts.map((text, i) => ({ page: i + 1, text })), 'text');

  let steps = file.steps;
  if (scanned) {
    const ranges = chunkPages(pagesNeedingOcr(texts));
    steps = insertSteps(steps, 'split', ranges.map((r) => ({ name: `ocr:${r.start}-${r.end}`, status: 'pending' as const })));
  }
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return {
    detail: `${pages} page(s), ${scanned ? 'scanned' : 'digital'} (${chars.toLocaleString('en-US')} characters of text)`,
    steps,
    patch: { sha256, page_count: pages, is_scanned: scanned, file_size: bytes.length },
  };
}

async function stepOcr(file: LeaseFileRow, name: string, aiImpl: PipelineAi): Promise<StepOutcome> {
  const [start, end] = name.slice(4).split('-').map(Number);
  const bytes = await downloadBytes(file.storage_path);
  const part = await subPdf(bytes, start, end);
  const texts = await aiImpl.ocrPdf(aiCtx(file, 'ocr'), part, end - start + 1);
  await savePageTexts(file, texts.map((text, i) => ({ page: start + i, text })), 'ocr');
  return { detail: `OCR pages ${start}–${end}` };
}

async function stepSplit(file: LeaseFileRow, aiImpl: PipelineAi): Promise<StepOutcome> {
  const bytes = await downloadBytes(file.storage_path);
  const total = file.page_count ?? (await loadPdf(bytes)).getPageCount();
  const locale = await uploaderLocale(file.uploaded_by);
  // Economy mode: finding document boundaries only needs the start and end of each page, not the whole PDF.
  const pageTexts = (await aiMode()) === 'economy' ? await loadFilePageTexts(file.id) : null;
  const input: ai.DocumentInput = pageTexts && hasUsableText(pageTexts.map((p) => p.text))
    ? { kind: 'text', pages: pageTexts.map((p) => ({ page: p.page, text: pagePreview(p.text) })) }
    : fitsAiPdfLimits(total, bytes.length)
      ? { kind: 'pdf', bytes, title: file.file_name }
      : { kind: 'text', pages: await loadFilePageTexts(file.id) };
  const result = await aiImpl.splitFile(aiCtx(file, analysisProcess(file)), input, total, locale);
  return applySplitResult(file, normalizeSplit(result, total), bytes);
}

/** Save split documents and schedule one abstract step per document (main leases first). Non-AI. */
export async function applySplitResult(file: LeaseFileRow, docs: SplitDocument[], bytes?: Uint8Array): Promise<StepOutcome> {
  const saved = await saveSplit(file, docs, bytes);
  const order = [...saved].sort((a, b) => Number(b.doc_type === 'main_lease') - Number(a.doc_type === 'main_lease') || a.index - b.index);
  const withoutOld = file.steps.filter((s) => !s.name.startsWith('abstract:'));
  const steps = insertSteps(withoutOld, 'finalize', order.map((d) => ({ name: `abstract:${d.index}`, status: 'pending' as const })));
  const summary = saved.map((d) => `${d.doc_type} p.${d.page_start}–${d.page_end}`).join(', ');
  return { detail: `${saved.length} document(s): ${summary}`, steps, work: { ...file.work, documents: saved, abstracts: undefined } };
}

async function stepAbstract(file: LeaseFileRow, name: string, aiImpl: PipelineAi): Promise<StepOutcome> {
  const index = Number(name.slice('abstract:'.length));
  const doc = (file.work.documents ?? []).find((d) => d.index === index);
  if (!doc?.document_id) throw new Error(`Document ${index} is missing; re-analyze the file.`);
  const saved = file.work.abstracts?.[String(index)];
  if (saved) {
    await logStep(file, name, 'Reusing the saved AI result from the previous attempt (no new AI call).');
    return applyAbstractResult(file, doc, saved);
  }
  const row = must(await db().from('documents').select('id, storage_path, page_count, title').eq('id', doc.document_id).single(), 'load document') as {
    id: string; storage_path: string | null; page_count: number | null; title: string | null;
  };
  const input = await documentInput(row);
  const siblings = (file.work.documents ?? []).filter((d) => d.index !== index)
    .map((d) => ({ index: d.index, doc_type: d.doc_type, title: d.title, page_start: d.page_start, page_end: d.page_end }));
  const candidates = (await leaseCandidates(file.org_id)).map(({ main_document_id: _m, ...rest }) => rest);
  const locale = await uploaderLocale(file.uploaded_by);
  const { classifier } = await orgClauseClassifier(file.org_id);
  const effort = (await aiMode()) === 'economy' ? 'medium' : 'high';
  const result = await aiImpl.abstractDocument(
    aiCtx(file, analysisProcess(file), file.target_lease_id),
    input,
    { docType: doc.doc_type, title: doc.title, siblings, candidates, targetLeaseId: file.target_lease_id, classifyClauses: classifier === 'claude', effort },
    locale,
  );
  // Save the paid-for result first, so a failure while applying it doesn't repeat the AI call on retry.
  file.work = { ...file.work, abstracts: { ...(file.work.abstracts ?? {}), [String(index)]: result } };
  await saveFile(file.id, { work: file.work });
  return applyAbstractResult(file, doc, result);
}

/**
 * Link a document to its lease, store the abstract, and classify its clauses with the organization's classifier
 * (Claude reuses the abstract's clauses; SVM is local; a Vercel AI Gateway model makes its own call).
 */
export async function applyAbstractResult(file: LeaseFileRow, doc: SplitDocument, result: Parameters<typeof applyAbstract>[1]): Promise<StepOutcome> {
  const link = await resolveLease(file, file.work, doc, result.link ?? null);
  await applyAbstract(doc, result, link.leaseId);
  const clauses = await classifyDocumentClauses(
    { id: doc.document_id!, org_id: file.org_id, lease_id: link.leaseId, file_id: file.id, storage_path: null, page_count: null, title: doc.title },
    { userId: file.uploaded_by, locale: await uploaderLocale(file.uploaded_by), process: analysisProcess(file), claudeClauses: result.clauses ?? [] },
  );
  // Keep the lease's terms current as each document lands (finalize recomputes again).
  await recomputeLease(link.leaseId);
  const touched = [...new Set([...(file.work.touched_lease_ids ?? []), link.leaseId])];
  return {
    detail: `${doc.doc_type} p.${doc.page_start}–${doc.page_end} → lease ${link.leaseId.slice(0, 8)} (${link.reason}${link.created ? ', created' : ''}); ${clauses.count} clause(s) by ${clauses.source}${clauses.note ? ` — ${clauses.note}` : ''}`,
    work: { ...file.work, touched_lease_ids: touched, abstracts: withoutKey(file.work.abstracts, String(doc.index)) },
  };
}

/** Recompute every touched lease and mark the file completed. Non-AI. */
export async function stepFinalize(file: LeaseFileRow): Promise<StepOutcome> {
  const docs = must(await db().from('documents').select('lease_id').eq('file_id', file.id)) as { lease_id: string | null }[];
  const ids = new Set<string>([
    ...(file.work.touched_lease_ids ?? []),
    ...(file.work.previous ?? []).map((p) => p.lease_id),
    ...docs.map((d) => d.lease_id).filter((v): v is string => Boolean(v)),
  ]);
  for (const id of ids) await recomputeLease(id);
  return {
    detail: `${docs.length} document(s) in ${new Set(docs.map((d) => d.lease_id)).size} lease(s)`,
    patch: { status: 'completed', processed_at: new Date().toISOString(), error: null },
  };
}

async function runStep(file: LeaseFileRow, step: PipelineStep, aiImpl: PipelineAi): Promise<StepOutcome> {
  if (step.name === 'prepare') return stepPrepare(file);
  if (step.name.startsWith('ocr:')) return stepOcr(file, step.name, aiImpl);
  if (step.name === 'split') return stepSplit(file, aiImpl);
  if (step.name.startsWith('abstract:')) return stepAbstract(file, step.name, aiImpl);
  if (step.name === 'finalize') return stepFinalize(file);
  throw new Error(`Unknown step ${step.name}`);
}

// ---- Worker loop ----------------------------------------------------------------------------------

export type RunOutcome = 'completed' | 'failed' | 'paused' | 'locked' | 'idle';

/**
 * Run pending steps of a file while holding its lock, until done, failed, `maxSteps` reached or the time budget used.
 * Pass `claimed: true` when the caller already holds the lock.
 */
export async function runFile(fileId: string, opts: { budgetMs?: number; maxSteps?: number; claimed?: boolean; ai?: PipelineAi } = {}): Promise<RunOutcome> {
  const started = Date.now();
  const budget = opts.budgetMs ?? BACKGROUND_BUDGET_MS;
  const aiImpl = opts.ai ?? defaultAi;
  if (!opts.claimed && !(await claimLock(fileId))) {
    const f = await loadFile(fileId);
    return f.status === 'queued' || f.status === 'processing' ? 'locked' : 'idle';
  }
  let ran = 0;
  try {
    for (;;) {
      const file = await loadFile(fileId);
      if (file.status !== 'queued' && file.status !== 'processing') return 'idle';
      if (file.steps.length === 0) {
        file.steps = initialSteps();
        await saveFile(fileId, { steps: file.steps });
        await logStep(file, null, `Processing started (${file.work.mode === 'reanalysis' ? 're-analysis' : 'analysis'})`);
      }
      const step = file.steps.find((s) => s.status === 'pending' || s.status === 'running');
      if (!step) {
        await saveFile(fileId, { status: 'completed', processed_at: new Date().toISOString() });
        return 'completed';
      }
      if (ran >= (opts.maxSteps ?? Number.POSITIVE_INFINITY) || Date.now() - started > budget) return 'paused';

      await renewLock(fileId);
      step.status = 'running';
      step.started_at = new Date().toISOString();
      step.finished_at = null;
      step.detail = null;
      await saveFile(fileId, { status: 'processing', steps: file.steps, error: null });
      await logStep(file, step.name, `Started ${step.name}`);

      try {
        const outcome = await runStep(file, step, aiImpl);
        const steps = outcome.steps ?? file.steps;
        const s = steps.find((x) => x.name === step.name) ?? step;
        s.status = 'done';
        s.finished_at = new Date().toISOString();
        s.detail = outcome.detail;
        await saveFile(fileId, { steps, ...(outcome.work ? { work: outcome.work } : {}), ...(outcome.patch ?? {}) });
        await logStep(file, step.name, outcome.detail);
        ran += 1;
        if (outcome.patch?.status === 'completed') {
          await logStep(file, null, 'Processing completed');
          return 'completed';
        }
      } catch (err) {
        const message = errorMessage(err);
        step.status = 'failed';
        step.finished_at = new Date().toISOString();
        step.detail = message;
        await saveFile(fileId, { status: 'failed', error: message, steps: file.steps });
        await logStep(file, step.name, message, 'error');
        log.error('pipeline.step', `Step ${step.name} failed: ${message}`, { fileId, orgId: file.org_id, step: step.name, ...errorFields(err) });
        return 'failed';
      }
    }
  } finally {
    await saveFile(fileId, { lock_until: null }).catch(() => undefined);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === 'ai_not_configured') {
    return 'AI is not configured (ANTHROPIC_API_KEY is not set on the API). Retry the file once AI has been set up.';
  }
  const msg = (err as Error)?.message || String(err);
  return msg.length > 1000 ? `${msg.slice(0, 1000)}…` : msg;
}

/** Kick off background processing (returns immediately). */
export function startProcessing(fileId: string): void {
  runInBackground(() => runFile(fileId));
}

/** For POST /files/:id/process: take the lock now; if free, continue in the background. */
export async function continueProcessing(fileId: string): Promise<'started' | 'locked' | 'idle'> {
  const file = await loadFile(fileId);
  if (file.status !== 'queued' && file.status !== 'processing') return 'idle';
  if (!(await claimLock(fileId))) return 'locked';
  runInBackground(() => runFile(fileId, { claimed: true }));
  return 'started';
}

// ---- Retry / re-analyze / delete ------------------------------------------------------------------

/** Failed file → queued, resuming from the failed step. */
export async function prepareRetry(fileId: string): Promise<LeaseFileRow> {
  const file = await loadFile(fileId);
  if (file.status !== 'failed') throw new ApiError('conflict', 'Only failed files can be retried.');
  const steps = file.steps.map((s) => (s.status === 'failed' || s.status === 'running' ? { ...s, status: 'pending' as const, detail: null } : s));
  await saveFile(fileId, { status: 'queued', error: null, steps, lock_until: null });
  await logStep(file, null, 'Retry requested');
  return loadFile(fileId);
}

/**
 * Re-run split & abstract. The current document → lease mapping is remembered so the same leases are reused
 * (saved rent audits, CAM reconciliations, insights and attachments stay attached).
 */
export async function prepareReanalysis(fileId: string): Promise<LeaseFileRow> {
  const file = await loadFile(fileId);
  if ((file.status === 'processing' || file.status === 'queued') && isLocked(file)) {
    throw new ApiError('conflict', 'The file is being processed. Try again when it has finished.');
  }
  const previous = file.work.mode === 'reanalysis' && file.work.previous?.length && file.status !== 'completed'
    ? file.work.previous // an unfinished re-analysis: keep the original mapping
    : await previousMapping(fileId);
  const kept = file.steps.filter((s) => (s.name === 'prepare' || s.name.startsWith('ocr:')) && s.status === 'done');
  const steps: PipelineStep[] = kept.length && kept[0].name === 'prepare'
    ? [...kept, { name: 'split', status: 'pending' }, { name: 'finalize', status: 'pending' }]
    : initialSteps();
  const work: FileWork = { mode: 'reanalysis', previous, touched_lease_ids: [...new Set(previous.map((p) => p.lease_id))] };
  await saveFile(fileId, { status: 'queued', error: null, steps, work, lock_until: null, processed_at: null });
  await logStep(file, null, `Re-analysis requested (${previous.length} document(s) previously linked)`);
  return loadFile(fileId);
}

/** Delete a file, its documents and stored PDFs; leases left empty are removed. */
export async function deleteFileCompletely(fileId: string): Promise<{ documents: number; leases_removed: number }> {
  const file = await loadFile(fileId);
  const docCount = (must(await db().from('documents').select('id').eq('file_id', fileId)) as unknown[]).length;
  const leaseIds = await removeFileDocuments(fileId);
  await removePaths([file.storage_path]);
  must(await db().from('lease_files').delete().eq('id', fileId), 'delete file');
  let removed = 0;
  for (const id of leaseIds) {
    await recomputeLease(id);
    const { data } = await db().from('leases').select('id').eq('id', id).maybeSingle();
    if (!data) removed += 1;
  }
  return { documents: docCount, leases_removed: removed };
}
