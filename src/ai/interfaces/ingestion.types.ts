/**
 * Every shape the pipeline produces lives in this file.
 * The frontend reads the same JSON, so this file doubles as the API contract.
 */

export type StageId =
  | 'parse'
  | 'markdown'
  | 'metadata'
  | 'clean'
  | 'recursive'
  | 'semantic'
  | 'parentChild'
  | 'summary';

export const STAGE_LABELS: Record<StageId, string> = {
  parse: 'Parse PDF',
  markdown: 'Convert to Markdown',
  metadata: 'Extract metadata',
  clean: 'Clean document',
  recursive: 'Recursive chunking',
  semantic: 'Semantic chunking',
  parentChild: 'Parent-child tree',
  summary: 'Gemini summary',
};

/** One visual line of text read from the PDF, with the layout hints we need for headings. */
export interface PdfLine {
  text: string;
  fontSize: number;
  page: number;
  /** True when a paragraph break (extra vertical gap or new page) comes before this line. */
  gapBefore: boolean;
}

export interface ParsedPdf {
  text: string;
  lines: PdfLine[];
  pageCount: number;
  info: Record<string, unknown>;
  pdfVersion: string | null;
}

export interface DocumentMetadata {
  title: string;
  fileName: string;
  fileSizeBytes: number;
  pageCount: number;
  author: string | null;
  creator: string | null;
  producer: string | null;
  createdAt: string | null;
  pdfVersion: string | null;
  wordCount: number;
  characterCount: number;
  readingTimeMinutes: number;
  language: string;
  headingCount: number;
  paragraphCount: number;
  listItemCount: number;
  keywords: string[];
}

export interface CleaningStep {
  name: string;
  description: string;
  /** How many items this step changed or removed. */
  affected: number;
}

export interface CleaningReport {
  steps: CleaningStep[];
  charsBefore: number;
  charsAfter: number;
  reductionPercent: number;
}

export interface CleanedDocument {
  markdown: string;
  report: CleaningReport;
}

export type SplitLevel = 'section' | 'paragraph' | 'line' | 'sentence' | 'word' | 'character';

export interface Chunk {
  id: string;
  index: number;
  content: string;
  headingPath: string[];
  charCount: number;
  wordCount: number;
  tokenEstimate: number;
  strategy: 'recursive' | 'semantic';
  /** Recursive only: the smallest unit we had to split on to make this chunk fit. */
  splitLevel?: SplitLevel;
  /** Recursive only: characters copied from the previous chunk. */
  overlapChars?: number;
  /** Semantic only: why a new chunk started here. */
  boundaryReason?: string;
  /** Semantic only: rules that kept paragraphs together inside this chunk. */
  groupingRules?: string[];
}

export interface ChildChunk {
  id: string;
  parentId: string;
  index: number;
  content: string;
  charCount: number;
  tokenEstimate: number;
}

export interface ParentChunk {
  id: string;
  title: string;
  headingPath: string[];
  markdown: string;
  charCount: number;
  childChunks: ChildChunk[];
}

export interface SizeSummary {
  count: number;
  minChars: number;
  avgChars: number;
  maxChars: number;
  totalTokens: number;
}

export interface ChunkStats {
  recursive: SizeSummary;
  semantic: SizeSummary;
  parents: number;
  children: number;
  avgChildrenPerParent: number;
  child: SizeSummary;
}

export interface GeminiSummary {
  summary: string;
  keyPoints: string[];
  topics: string[];
  documentType: string;
}

export interface StageTiming {
  stage: StageId;
  label: string;
  status: 'done' | 'failed';
  durationMs: number;
  detail?: string;
}

export interface IngestionSettings {
  recursiveSize: number;
  recursiveOverlap: number;
  semanticMin: number;
  semanticMax: number;
  semanticThreshold: number;
  parentHeadingLevel: number;
  parentMax: number;
  childSize: number;
  childOverlap: number;
  geminiModel: string;
}

/** The full JSON returned by POST /ai/upload. */
export interface IngestionResult {
  file: { name: string; sizeBytes: number; mimeType: string };
  markdown: string;
  metadata: DocumentMetadata;
  cleaned: CleanedDocument;
  chunks: {
    recursive: Chunk[];
    semantic: Chunk[];
    parentChild: ParentChunk[];
  };
  summary: GeminiSummary | null;
  summaryError: string | null;
  stats: ChunkStats;
  settings: IngestionSettings;
  timeline: StageTiming[];
  totalMs: number;
}

/** Events streamed by POST /ai/upload/stream (one JSON object per line). */
export type PipelineEvent =
  | { type: 'start'; fileName: string; fileSizeBytes: number }
  | {
      type: 'stage';
      stage: StageId;
      status: 'running' | 'done' | 'failed';
      durationMs?: number;
      detail?: string;
      data?: Record<string, unknown>;
    }
  | { type: 'complete'; totalMs: number; stats: ChunkStats; settings: IngestionSettings }
  | { type: 'error'; message: string };

export type EventEmitter = (event: PipelineEvent) => void;
