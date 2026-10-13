// Shared types for the lease ingestion pipeline (lease_files.steps / lease_files.work).
import type { DocType } from '../types.ts';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** One entry of lease_files.steps. `name` is unique within a file: prepare, ocr:1-20, split, abstract:0, finalize. */
export interface PipelineStep {
  name: string;
  status: StepStatus;
  started_at?: string | null;
  finished_at?: string | null;
  detail?: string | null;
}

export interface SplitDocument {
  index: number;
  doc_type: DocType;
  title: string | null;
  effective_date: string | null;
  page_start: number;
  page_end: number;
  /** Set once the documents row exists. */
  document_id?: string | null;
}

/** Previous document → lease mapping, kept across a re-analysis so lease ids survive. */
export interface PreviousMapping {
  lease_id: string;
  doc_type: DocType;
  page_start: number | null;
  page_end: number | null;
}

export interface FileWork {
  mode?: 'analysis' | 'reanalysis';
  documents?: SplitDocument[];
  previous?: PreviousMapping[];
  touched_lease_ids?: string[];
}

export interface LeaseFileRow {
  id: string;
  org_id: string;
  uploaded_by: string | null;
  file_name: string;
  storage_path: string;
  file_size: number | null;
  sha256: string | null;
  page_count: number | null;
  is_scanned: boolean | null;
  source: string;
  target_lease_id: string | null;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  error: string | null;
  steps: PipelineStep[];
  work: FileWork;
  lock_until: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
}

/** Result of the split & classify step (AI output or hand-made in tests). */
export interface SplitResult {
  documents: {
    doc_type: DocType;
    title: string | null;
    effective_date: string | null;
    page_start: number;
    page_end: number;
  }[];
}

export interface SignatureResult {
  status: 'signed' | 'partially_signed' | 'unsigned' | 'unclear';
  method: 'ink' | 'digital' | 'docusign' | 'adobe_sign' | 'none' | 'unknown';
  parties: { party: string; signer: string | null; date: string | null }[];
  signature_pages: number[];
  notes: string | null;
}

export interface ClauseResult {
  clause_type: string;
  confidence: number;
  alternatives: { type: string; confidence: number }[];
  section: string | null;
  page: number | null;
  paragraph: number | null;
  line: number | null;
  excerpt: string;
}

/** Result of the abstract step for one document (AI output or hand-made in tests). */
export interface AbstractResult {
  fields: Record<string, { value: string | number | null; page: number | null }>;
  summary: string | null;
  changes_made: string | null;
  effective_date: string | null;
  clauses: ClauseResult[];
  signature: SignatureResult;
  link: {
    /** new_lease | same_file (document_index) | existing_lease (lease_id) */
    kind: 'new_lease' | 'same_file' | 'existing_lease';
    document_index: number | null;
    lease_id: string | null;
    reason: string | null;
  };
}
