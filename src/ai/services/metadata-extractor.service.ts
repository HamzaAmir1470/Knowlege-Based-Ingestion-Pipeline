import { Injectable } from '@nestjs/common';
import { DocumentMetadata, ParsedPdf } from '../interfaces/ingestion.types';
import { parseBlocks, stripMarkdown } from '../utils/markdown.util';
import { STOPWORDS, countWords, topKeywords } from '../utils/text.util';

/**
 * Stage 3: collect facts about the document.
 * Some come from the PDF itself (author, creation date). Others we compute from the Markdown.
 */
@Injectable()
export class MetadataExtractorService {
  extract(params: { parsed: ParsedPdf; markdown: string; fileName: string; fileSizeBytes: number }): DocumentMetadata {
    const { parsed, markdown, fileName, fileSizeBytes } = params;
    const blocks = parseBlocks(markdown);
    const headings = blocks.filter((b) => b.type === 'heading');
    const plainText = markdown.replace(/^#{1,6}\s+/gm, '');
    const words = countWords(plainText);

    return {
      title: this.pickTitle(parsed.info, headings.map((h) => stripMarkdown(h.text)), fileName),
      fileName,
      fileSizeBytes,
      pageCount: parsed.pageCount,
      author: this.text(parsed.info.Author),
      creator: this.text(parsed.info.Creator),
      producer: this.text(parsed.info.Producer),
      createdAt: this.parsePdfDate(this.text(parsed.info.CreationDate)),
      pdfVersion: parsed.pdfVersion,
      wordCount: words,
      characterCount: plainText.length,
      readingTimeMinutes: Math.max(1, Math.round(words / 220)),
      language: this.guessLanguage(plainText),
      headingCount: headings.length,
      paragraphCount: blocks.filter((b) => b.type === 'paragraph').length,
      listItemCount: blocks.filter((b) => b.type === 'list').reduce((sum, b) => sum + b.text.split('\n').filter((l) => /^\s*([-*+]|\d+[.)])\s/.test(l)).length, 0),
      keywords: topKeywords(plainText, 8),
    };
  }

  private text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  /** Prefer the PDF's own title, then the first heading, then the file name. */
  private pickTitle(info: Record<string, unknown>, headings: string[], fileName: string): string {
    const fromInfo = this.text(info.Title);
    if (fromInfo && fromInfo.toLowerCase() !== 'untitled') return fromInfo;
    if (headings[0]) return headings[0];
    return fileName.replace(/\.pdf$/i, '');
  }

  /** PDF dates look like D:20260131120000+05'00'. Convert to an ISO string when possible. */
  private parsePdfDate(raw: string | null): string | null {
    const match = raw?.match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
    if (!match) return null;
    const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = match;
    const date = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  /** Counts common English words. Good enough to say "English" or "Unknown" without a library. */
  private guessLanguage(text: string): string {
    const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
    if (words.length < 20) return 'Unknown';
    const common = words.filter((w) => STOPWORDS.has(w)).length;
    return common / words.length > 0.25 ? 'English' : 'Unknown (not detected as English)';
  }
}
