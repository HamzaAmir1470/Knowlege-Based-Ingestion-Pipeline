import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import pdfParse from 'pdf-parse';
import { ParsedPdf, PdfLine } from '../interfaces/ingestion.types';

/** Shape of one text item returned by pdf.js (the engine behind pdf-parse). */
interface PdfTextItem {
  str: string;
  height?: number;
  width?: number;
  transform: number[];
}

/**
 * Stage 1: PDF buffer in, text and layout hints out.
 *
 * pdf-parse already returns plain text. We add a custom `pagerender` function so we also learn
 * each line's font size and where paragraph gaps are. The Markdown converter uses those hints
 * to decide what is a heading and what is a paragraph.
 */
@Injectable()
export class PdfParserService {
  async parse(buffer: Buffer): Promise<ParsedPdf> {
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new UnprocessableEntityException('This file is not a valid PDF.');
    }

    const lines: PdfLine[] = [];

    const renderPage = async (pageData: {
      pageNumber: number;
      getTextContent: (options: object) => Promise<{ items: PdfTextItem[] }>;
    }): Promise<string> => {
      const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      const pageLines = this.groupItemsIntoLines(content.items, pageData.pageNumber);
      lines.push(...pageLines);
      return pageLines.map((l) => (l.gapBefore ? `\n${l.text}` : l.text)).join('\n');
    };

    let data: Awaited<ReturnType<typeof pdfParse>>;
    try {
      // pdf-parse types ask for a sync function, but the library awaits the result, so async is fine.
      data = await pdfParse(buffer, { pagerender: renderPage as unknown as (page: unknown) => string });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      throw new UnprocessableEntityException(`Could not read this PDF (${reason}). It may be damaged or password protected.`);
    }

    if (!data.text || !data.text.trim() || lines.length === 0) {
      throw new UnprocessableEntityException(
        'No text found in this PDF. It looks like a scanned document. Scanned PDFs need OCR, which is outside this lesson.',
      );
    }

    return {
      text: data.text,
      lines,
      pageCount: data.numpages,
      info: (data.info ?? {}) as Record<string, unknown>,
      pdfVersion: data.version ?? null,
    };
  }

  /** Items that share (almost) the same Y position belong to the same visual line. */
  private groupItemsIntoLines(items: PdfTextItem[], page: number): PdfLine[] {
    const rows: { y: number; parts: string[]; size: number; endX: number }[] = [];

    for (const item of items) {
      if (!item.str || !item.str.trim()) {
        // Whitespace-only items still matter: they separate words on the same row.
        const last = rows[rows.length - 1];
        if (last && item.str) last.parts.push(item.str);
        continue;
      }
      const y = item.transform[5];
      const x = item.transform[4];
      const size = item.height || Math.abs(item.transform[3]) || 0;
      const endX = x + (item.width ?? 0);
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - y) < 2) {
        // A wide horizontal gap means two separate pieces of text (for example a footer and its page number).
        if (x - last.endX > size * 1.5) last.parts.push('  ');
        last.parts.push(item.str);
        last.size = Math.max(last.size, size);
        last.endX = endX;
      } else {
        rows.push({ y, parts: [item.str], size, endX });
      }
    }

    const lines: PdfLine[] = [];
    rows.forEach((row, i) => {
      const text = row.parts.join('').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const previous = rows[i - 1];
      const gap = previous ? previous.y - row.y : 0;
      const referenceSize = Math.max(previous?.size ?? row.size, 1);
      lines.push({
        text,
        fontSize: Math.round(row.size * 2) / 2,
        page,
        // A negative gap means the text jumped back up the page (for example a footer drawn first).
        gapBefore: i === 0 || gap > referenceSize * 1.6 || gap < -referenceSize,
      });
    });
    return lines;
  }
}
