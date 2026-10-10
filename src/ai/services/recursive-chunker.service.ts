import { Injectable } from '@nestjs/common';
import { Chunk, SplitLevel } from '../interfaces/ingestion.types';
import { splitIntoSections } from '../utils/markdown.util';
import { countWords, estimateTokens, hardSplit, pad, splitSentences } from '../utils/text.util';

export interface RecursiveOptions {
  chunkSize: number;
  overlap: number;
  idPrefix?: string;
}

interface Piece {
  text: string;
  /** The separator that joined this piece to the previous one. */
  separator: string;
  level: SplitLevel;
}

/** Ordered from the largest natural boundary to the smallest. */
const LEVELS: { name: SplitLevel; separator: string; split: (text: string) => string[] }[] = [
  { name: 'paragraph', separator: '\n\n', split: (t) => t.split(/\n{2,}/) },
  { name: 'line', separator: '\n', split: (t) => t.split('\n') },
  { name: 'sentence', separator: ' ', split: (t) => splitSentences(t) },
  { name: 'word', separator: ' ', split: (t) => t.split(/\s+/) },
];

const HEADING_ONLY = /^#{1,6}\s+[^\n]+$/;

/**
 * Stage 5: recursive chunking.
 *
 * Idea: try the biggest natural boundary first. Only when a piece is still too large do we
 * move down one level.
 *
 *   section (heading)  ->  paragraph  ->  line  ->  sentence  ->  word
 *
 * Small neighbours are merged back together until the chunk is close to `chunkSize`,
 * and each new chunk starts with a short overlap taken from the previous one.
 */
@Injectable()
export class RecursiveChunkerService {
  chunk(markdown: string, options: RecursiveOptions): Chunk[] {
    const { chunkSize, overlap, idPrefix = 'rec' } = options;
    const chunks: Chunk[] = [];

    for (const section of splitIntoSections(markdown)) {
      const pieces = this.splitRecursively(section.text, chunkSize, -1, '');
      for (const merged of this.mergePieces(pieces, chunkSize, overlap)) {
        const content = merged.text.trim();
        if (!content) continue;
        chunks.push({
          id: `${idPrefix}-${pad(chunks.length + 1)}`,
          index: chunks.length,
          content,
          headingPath: section.headingPath,
          charCount: content.length,
          wordCount: countWords(content),
          tokenEstimate: estimateTokens(content),
          strategy: 'recursive',
          splitLevel: merged.level,
          overlapChars: merged.overlapChars,
        });
      }
    }
    return chunks;
  }

  /**
   * levelIndex -1 means "the whole section". If it already fits, we keep it as one piece.
   * Otherwise we split on the next level and recurse into every part that is still too big.
   */
  private splitRecursively(text: string, size: number, levelIndex: number, separator: string): Piece[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    const levelName: SplitLevel = levelIndex < 0 ? 'section' : LEVELS[levelIndex].name;
    if (trimmed.length <= size) return [{ text: trimmed, separator, level: levelName }];

    const next = levelIndex + 1;
    if (next >= LEVELS.length) {
      return hardSplit(trimmed, size).map((part, i) => ({
        text: part,
        separator: i === 0 ? separator : ' ',
        level: 'character' as SplitLevel,
      }));
    }

    const parts = LEVELS[next].split(trimmed).map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) return this.splitRecursively(trimmed, size, next, separator);

    return parts.flatMap((part, i) =>
      this.splitRecursively(part, size, next, i === 0 ? separator : LEVELS[next].separator),
    );
  }

  /** Glue small pieces together up to `size`. Headings never end a chunk on their own. */
  private mergePieces(pieces: Piece[], size: number, overlap: number) {
    const result: { text: string; level: SplitLevel; overlapChars: number }[] = [];
    let buffer = '';
    let bufferLevel: SplitLevel = 'section';
    let hasNewContent = false;
    let currentOverlap = 0;

    const flush = () => {
      if (hasNewContent && buffer.trim()) {
        result.push({ text: buffer, level: bufferLevel, overlapChars: currentOverlap });
        const tail = this.overlapTail(buffer, overlap);
        buffer = tail;
        currentOverlap = tail.length;
      } else {
        buffer = '';
        currentOverlap = 0;
      }
      hasNewContent = false;
      bufferLevel = 'section';
    };

    for (const piece of pieces) {
      const joiner = buffer ? piece.separator || ' ' : '';
      const wouldOverflow = buffer.length + joiner.length + piece.text.length > size;
      const bufferIsOnlyHeading = HEADING_ONLY.test(buffer.trim());

      if (hasNewContent && wouldOverflow && !bufferIsOnlyHeading) flush();

      buffer = buffer ? `${buffer}${piece.separator || ' '}${piece.text}` : piece.text;
      hasNewContent = true;
      bufferLevel = this.deeper(bufferLevel, piece.level);
    }
    if (hasNewContent) result.push({ text: buffer, level: bufferLevel, overlapChars: currentOverlap });
    return result;
  }

  /** Last `overlap` characters of a chunk, moved forward to the next word boundary. */
  private overlapTail(text: string, overlap: number): string {
    if (overlap <= 0 || text.length <= overlap) return '';
    const tail = text.slice(-overlap);
    const firstSpace = tail.search(/\s/);
    return firstSpace === -1 ? '' : tail.slice(firstSpace).trim();
  }

  private deeper(a: SplitLevel, b: SplitLevel): SplitLevel {
    const order: SplitLevel[] = ['section', 'paragraph', 'line', 'sentence', 'word', 'character'];
    return order.indexOf(b) > order.indexOf(a) ? b : a;
  }
}
