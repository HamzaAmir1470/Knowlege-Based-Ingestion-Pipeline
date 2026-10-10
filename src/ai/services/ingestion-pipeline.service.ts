import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Chunk,
  ChunkStats,
  CleanedDocument,
  DocumentMetadata,
  EventEmitter,
  IngestionResult,
  IngestionSettings,
  ParentChunk,
  STAGE_LABELS,
  SizeSummary,
  StageId,
  StageTiming,
  GeminiSummary,
} from '../interfaces/ingestion.types';
import { round, sleep } from '../utils/text.util';
import { GeminiSummaryService } from './gemini-summary.service';
import { MarkdownConverterService } from './markdown-converter.service';
import { MetadataExtractorService } from './metadata-extractor.service';
import { ParentChildService } from './parent-child.service';
import { PdfParserService } from './pdf-parser.service';
import { RecursiveChunkerService } from './recursive-chunker.service';
import { SemanticChunkerService } from './semantic-chunker.service';
import { TextCleanerService } from './text-cleaner.service';

export interface UploadedPdf {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * The orchestrator. It owns the order of the stages and nothing else.
 * Each stage is a separate service, so you can read, test or replace them one by one.
 *
 * Progress is reported through an optional `emit` callback. The streaming endpoint passes one in,
 * the plain JSON endpoint does not.
 */
@Injectable()
export class IngestionPipelineService {
  private readonly logger = new Logger(IngestionPipelineService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly pdfParser: PdfParserService,
    private readonly markdownConverter: MarkdownConverterService,
    private readonly metadataExtractor: MetadataExtractorService,
    private readonly textCleaner: TextCleanerService,
    private readonly recursiveChunker: RecursiveChunkerService,
    private readonly semanticChunker: SemanticChunkerService,
    private readonly parentChild: ParentChildService,
    private readonly gemini: GeminiSummaryService,
  ) {}

  async run(file: UploadedPdf, emit: EventEmitter = () => undefined): Promise<IngestionResult> {
    const startedAt = Date.now();
    const timeline: StageTiming[] = [];
    const settings = this.readSettings();
    const delay = this.config.getOrThrow<number>('pipeline.stageDelayMs');

    emit({ type: 'start', fileName: file.originalname, fileSizeBytes: file.size });

    /** Runs one stage, times it, reports it, and optionally pauses so the UI is easy to follow. */
    const stage = async <T>(
      id: StageId,
      work: () => Promise<T> | T,
      view: (result: T) => { detail?: string; data?: Record<string, unknown> },
      options: { pause: boolean } = { pause: true },
    ): Promise<T> => {
      const t0 = Date.now();
      emit({ type: 'stage', stage: id, status: 'running' });
      try {
        const result = await work();
        const durationMs = Date.now() - t0;
        const { detail, data } = view(result);
        timeline.push({ stage: id, label: STAGE_LABELS[id], status: 'done', durationMs, detail });
        emit({ type: 'stage', stage: id, status: 'done', durationMs, detail, data });
        if (options.pause && delay > 0) await sleep(delay);
        return result;
      } catch (error) {
        const durationMs = Date.now() - t0;
        const detail = error instanceof Error ? error.message : 'Unknown error';
        timeline.push({ stage: id, label: STAGE_LABELS[id], status: 'failed', durationMs, detail });
        emit({ type: 'stage', stage: id, status: 'failed', durationMs, detail });
        throw error;
      }
    };

    // 1. Parse
    const parsed = await stage('parse', () => this.pdfParser.parse(file.buffer), (p) => ({
      detail: `${p.pageCount} pages, ${p.lines.length} text lines`,
    }));

    // 2. Markdown
    const markdown = await stage('markdown', () => this.markdownConverter.convert(parsed.lines), (md) => ({
      detail: `${md.length.toLocaleString('en-US')} characters`,
      data: { markdown: md },
    }));

    // 3. Metadata
    const metadata: DocumentMetadata = await stage(
      'metadata',
      () =>
        this.metadataExtractor.extract({
          parsed,
          markdown,
          fileName: file.originalname,
          fileSizeBytes: file.size,
        }),
      (m) => ({ detail: `${m.wordCount.toLocaleString('en-US')} words, ${m.headingCount} headings`, data: { metadata: m } }),
    );

    // 4. Clean
    const cleaned: CleanedDocument = await stage(
      'clean',
      () => this.textCleaner.clean(markdown, parsed.pageCount),
      (c) => ({ detail: `${c.report.reductionPercent}% smaller`, data: { cleaned: c } }),
    );

    // 5. Recursive chunks
    const recursive: Chunk[] = await stage(
      'recursive',
      () =>
        this.recursiveChunker.chunk(cleaned.markdown, {
          chunkSize: settings.recursiveSize,
          overlap: settings.recursiveOverlap,
        }),
      (chunks) => ({ detail: `${chunks.length} chunks`, data: { chunks } }),
    );

    // 6. Semantic chunks
    const semantic: Chunk[] = await stage(
      'semantic',
      () =>
        this.semanticChunker.chunk(cleaned.markdown, {
          minChars: settings.semanticMin,
          maxChars: settings.semanticMax,
          threshold: settings.semanticThreshold,
        }),
      (chunks) => ({ detail: `${chunks.length} chunks`, data: { chunks } }),
    );

    // 7. Parent-child tree
    const parents: ParentChunk[] = await stage(
      'parentChild',
      () =>
        this.parentChild.build(cleaned.markdown, {
          parentHeadingLevel: settings.parentHeadingLevel,
          parentMax: settings.parentMax,
          childSize: settings.childSize,
          childOverlap: settings.childOverlap,
        }),
      (p) => ({
        detail: `${p.length} parents, ${p.reduce((sum, x) => sum + x.childChunks.length, 0)} children`,
        data: { parents: p },
      }),
    );

    // 8. Gemini summary. A failure here must not throw away the work above.
    let summary: GeminiSummary | null = null;
    let summaryError: string | null = null;
    try {
      summary = await stage(
        'summary',
        () => this.gemini.summarize(cleaned.markdown, metadata.title),
        (s) => ({ detail: `${s.keyPoints.length} key points`, data: { summary: s } }),
        { pause: false },
      );
    } catch (error) {
      summaryError = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Summary skipped: ${summaryError}`);
    }

    const stats = this.computeStats(recursive, semantic, parents);
    const totalMs = Date.now() - startedAt;
    emit({ type: 'complete', totalMs, stats, settings });

    return {
      file: { name: file.originalname, sizeBytes: file.size, mimeType: file.mimetype },
      markdown,
      metadata,
      cleaned,
      chunks: { recursive, semantic, parentChild: parents },
      summary,
      summaryError,
      stats,
      settings,
      timeline,
      totalMs,
    };
  }

  private readSettings(): IngestionSettings {
    const c = (key: string) => this.config.getOrThrow<number>(`chunking.${key}`);
    return {
      recursiveSize: c('recursiveSize'),
      recursiveOverlap: c('recursiveOverlap'),
      semanticMin: c('semanticMin'),
      semanticMax: c('semanticMax'),
      semanticThreshold: c('semanticThreshold'),
      parentHeadingLevel: c('parentHeadingLevel'),
      parentMax: c('parentMax'),
      childSize: c('childSize'),
      childOverlap: c('childOverlap'),
      geminiModel: this.config.getOrThrow<string>('gemini.model'),
    };
  }

  private computeStats(recursive: Chunk[], semantic: Chunk[], parents: ParentChunk[]): ChunkStats {
    const children = parents.flatMap((p) => p.childChunks);
    return {
      recursive: this.summarizeSizes(recursive),
      semantic: this.summarizeSizes(semantic),
      child: this.summarizeSizes(children),
      parents: parents.length,
      children: children.length,
      avgChildrenPerParent: parents.length ? round(children.length / parents.length) : 0,
    };
  }

  private summarizeSizes(items: { charCount: number; tokenEstimate: number }[]): SizeSummary {
    if (items.length === 0) return { count: 0, minChars: 0, avgChars: 0, maxChars: 0, totalTokens: 0 };
    const sizes = items.map((i) => i.charCount);
    return {
      count: items.length,
      minChars: Math.min(...sizes),
      avgChars: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
      maxChars: Math.max(...sizes),
      totalTokens: items.reduce((sum, i) => sum + i.tokenEstimate, 0),
    };
  }
}
