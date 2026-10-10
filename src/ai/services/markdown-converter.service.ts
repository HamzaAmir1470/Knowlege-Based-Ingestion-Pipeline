import { Injectable } from '@nestjs/common';
import { PdfLine } from '../interfaces/ingestion.types';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

const BULLET = /^([•●▪◦‣·○■]\s*|[-–*]\s+)/;
const NUMBERED_ITEM = /^(\d{1,3})[.)]\s+/;
const NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,2}){0,3})[.)]?\s+[A-Z]/;
const NAMED_HEADING = /^(chapter|section|part|appendix)\s+[\dIVXA-Z]+\b/i;
const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'with', 'vs', 'by', 'at', 'from', 'is']);

/**
 * Stage 2: layout lines in, Markdown out.
 *
 * Heading detection uses three signals, strongest first:
 *   1. Font size. Lines noticeably larger than the body text are headings.
 *   2. Numbering. "2.1 Chunk size" becomes a level 3 heading.
 *   3. Shape. Short, ALL CAPS or Title Case lines standing alone become headings.
 */
@Injectable()
export class MarkdownConverterService {
  convert(lines: PdfLine[]): string {
    const bodySize = this.findBodyFontSize(lines);
    const sizeToLevel = this.mapSizesToLevels(lines, bodySize);
    const blocks = this.buildBlocks(lines, sizeToLevel);
    return this.render(blocks);
  }

  /** The body font size is the one that covers the most characters. */
  private findBodyFontSize(lines: PdfLine[]): number {
    const weights = new Map<number, number>();
    for (const line of lines) weights.set(line.fontSize, (weights.get(line.fontSize) ?? 0) + line.text.length);
    return [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12;
  }

  /** Largest size becomes "#", next becomes "##", and so on. Up to three levels. */
  private mapSizesToLevels(lines: PdfLine[], bodySize: number): Map<number, number> {
    const larger = [...new Set(lines.map((l) => l.fontSize))]
      .filter((size) => size >= bodySize * 1.12)
      .sort((a, b) => b - a)
      .slice(0, 3);
    return new Map(larger.map((size, i) => [size, i + 1]));
  }

  private buildBlocks(lines: PdfLine[], sizeToLevel: Map<number, number>): Block[] {
    const blocks: Block[] = [];
    let paragraph: string[] = [];
    let list: string[] | null = null;

    const flushParagraph = () => {
      if (paragraph.length) blocks.push({ kind: 'paragraph', text: this.joinWrappedLines(paragraph) });
      paragraph = [];
    };
    const flushList = () => {
      if (list?.length) blocks.push({ kind: 'list', items: list });
      list = null;
    };
    const flushAll = () => {
      flushParagraph();
      flushList();
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const next = lines[i + 1];
      const text = line.text;

      // 1. Heading by font size. Consecutive lines with the same big size are one heading.
      const sizeLevel = sizeToLevel.get(line.fontSize);
      if (sizeLevel && text.length <= 140) {
        flushAll();
        const last = blocks[blocks.length - 1];
        if (!line.gapBefore && last?.kind === 'heading' && last.level === sizeLevel) last.text += ` ${text}`;
        else blocks.push({ kind: 'heading', level: sizeLevel, text });
        continue;
      }

      // 2. Heading by numbering or keywords ("2.1 Chunk size", "Chapter 3").
      const patternLevel = this.headingLevelByPattern(text, line, next);
      if (patternLevel) {
        flushAll();
        blocks.push({ kind: 'heading', level: patternLevel, text: text.replace(/[.:]\s*$/, '') });
        continue;
      }

      // 3. Lists.
      const bullet = text.match(BULLET);
      const numbered = text.match(NUMBERED_ITEM);
      if (bullet || numbered) {
        flushParagraph();
        if (!list) list = [];
        list.push(bullet ? `- ${text.slice(bullet[0].length)}` : `${numbered![1]}. ${text.slice(numbered![0].length)}`);
        continue;
      }

      // 4. Wrapped list item: continues the previous item when no paragraph gap exists.
      if (list && !line.gapBefore) {
        list[list.length - 1] = this.joinTwo(list[list.length - 1], text);
        continue;
      }

      // 5. Normal paragraph text.
      flushList();
      if (line.gapBefore) flushParagraph();
      paragraph.push(text);
    }
    flushAll();
    return blocks;
  }

  private headingLevelByPattern(text: string, line: PdfLine, next: PdfLine | undefined): number | null {
    if (text.length > 80 || /[.,;!?]$/.test(text)) return null;

    const numbered = text.match(NUMBERED_HEADING);
    if (numbered) return Math.min(numbered[1].split('.').length + 1, 4); // "1" -> ##, "1.1" -> ###
    if (NAMED_HEADING.test(text)) return 2;

    const standsAlone = line.gapBefore || !next || next.gapBefore;
    if (!standsAlone) return null;

    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 4 && letters === letters.toUpperCase() && text.split(/\s+/).length <= 10) return 2;

    if (line.gapBefore && this.isTitleCase(text)) return 3;
    return null;
  }

  private isTitleCase(text: string): boolean {
    const words = text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
    if (words.length === 0 || words.length > 8) return false;
    if (BULLET.test(text) || NUMBERED_ITEM.test(text)) return false;
    const major = words.filter((w) => !SMALL_WORDS.has(w.toLowerCase()));
    if (major.length === 0) return false;
    const capitalised = major.filter((w) => /^[A-Z0-9]/.test(w)).length;
    return capitalised / major.length >= 0.8;
  }

  /** Joins wrapped lines with spaces and repairs words that were hyphenated at the line break. */
  private joinWrappedLines(lines: string[]): string {
    return lines.reduce((acc, line) => (acc ? this.joinTwo(acc, line) : line), '');
  }

  private joinTwo(a: string, b: string): string {
    if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
    return `${a} ${b}`;
  }

  private render(blocks: Block[]): string {
    const out: string[] = [];
    for (const block of blocks) {
      if (block.kind === 'heading') {
        out.push(`${'#'.repeat(block.level)} ${block.text}`);
      } else if (block.kind === 'list') {
        out.push(block.items.join('\n'));
      } else {
        out.push(block.text);
      }
    }
    return out.join('\n\n').trim() + '\n';
  }
}
