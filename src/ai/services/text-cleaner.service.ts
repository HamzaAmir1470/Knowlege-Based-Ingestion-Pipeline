import { Injectable } from '@nestjs/common';
import { CleanedDocument, CleaningStep } from '../interfaces/ingestion.types';
import { round } from '../utils/text.util';

interface StepResult {
  text: string;
  affected: number;
}

/**
 * Stage 4: the cleaning pipeline.
 * Each step is a small function that takes text and returns { text, affected }.
 * The service runs them in order and records a report, so the dashboard can show what changed.
 * To add a step, write one more function and add it to the `steps` list.
 */
@Injectable()
export class TextCleanerService {
  clean(markdown: string, pageCount: number): CleanedDocument {
    const steps: { name: string; description: string; run: (text: string) => StepResult }[] = [
      {
        name: 'Normalize characters',
        description: 'Fix ligatures, curly quotes and non-breaking spaces.',
        run: (t) => this.normalizeCharacters(t),
      },
      {
        name: 'Remove invisible characters',
        description: 'Strip control, zero-width and soft-hyphen characters.',
        run: (t) => this.removeInvisible(t),
      },
      {
        name: 'Remove page numbers',
        description: 'Delete lines such as "3", "Page 3 of 10" or "- 3 -".',
        run: (t) => this.removePageNumbers(t),
      },
      {
        name: 'Remove repeated headers and footers',
        description: 'Delete short lines that repeat on most pages.',
        run: (t) => this.removeRepeatedLines(t, pageCount),
      },
      {
        name: 'Fix spacing and punctuation',
        description: 'Collapse double spaces and remove spaces before punctuation.',
        run: (t) => this.fixSpacing(t),
      },
      {
        name: 'Remove duplicate blocks',
        description: 'Delete a paragraph that repeats directly after itself.',
        run: (t) => this.removeDuplicateBlocks(t),
      },
      {
        name: 'Remove empty headings',
        description: 'Delete headings that have no text.',
        run: (t) => this.removeEmptyHeadings(t),
      },
      {
        name: 'Tidy blank lines',
        description: 'Keep exactly one blank line between blocks.',
        run: (t) => this.tidyBlankLines(t),
      },
    ];

    let text = markdown;
    const report: CleaningStep[] = [];
    for (const step of steps) {
      const result = step.run(text);
      text = result.text;
      report.push({ name: step.name, description: step.description, affected: result.affected });
    }

    const charsBefore = markdown.length;
    const charsAfter = text.length;
    return {
      markdown: text,
      report: {
        steps: report,
        charsBefore,
        charsAfter,
        reductionPercent: charsBefore ? round(((charsBefore - charsAfter) / charsBefore) * 100) : 0,
      },
    };
  }

  private normalizeCharacters(text: string): StepResult {
    let affected = 0;
    const replaceAll = (input: string, pattern: RegExp, replacement: string) =>
      input.replace(pattern, () => {
        affected++;
        return replacement;
      });

    // NFKC turns ligatures such as "ﬁ" into "fi".
    const normalized = text.normalize('NFKC');
    if (normalized !== text) affected += 1;

    let out = normalized;
    out = replaceAll(out, /[\u201C\u201D\u201E]/g, '"');
    out = replaceAll(out, /[\u2018\u2019\u201A]/g, "'");
    out = replaceAll(out, /[\u00A0\u2007\u202F]/g, ' ');
    out = out.replace(/\r\n?/g, '\n');
    return { text: out, affected };
  }

  private removeInvisible(text: string): StepResult {
    let affected = 0;
    const out = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200D\u2060\uFEFF\u00AD]/g, () => {
      affected++;
      return '';
    });
    return { text: out, affected };
  }

  private blocks(text: string): string[] {
    return text.split(/\n{2,}/);
  }

  private removePageNumbers(text: string): StepResult {
    const pageNumber = /^(?:page\s+)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$|^[-–—]\s*\d{1,4}\s*[-–—]$/i;
    let affected = 0;
    const kept = this.blocks(text).filter((block) => {
      const isPageNumber = pageNumber.test(block.trim().replace(/^#{1,6}\s+/, ''));
      if (isPageNumber) affected++;
      return !isPageNumber;
    });
    return { text: kept.join('\n\n'), affected };
  }

  /**
   * Running headers and footers repeat on every page. We count short blocks (ignoring digits,
   * case and "#" markers) and delete the ones that appear on most pages.
   */
  private removeRepeatedLines(text: string, pageCount: number): StepResult {
    const normalise = (block: string) => block.trim().replace(/^#{1,6}\s+/, '').replace(/\d+/g, '#').toLowerCase();
    const blocks = this.blocks(text);
    const counts = new Map<string, number>();
    for (const block of blocks) {
      if (block.length > 80 || block.includes('\n')) continue;
      const key = normalise(block);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const threshold = Math.max(2, Math.ceil(pageCount * 0.6));
    let affected = 0;
    const kept = blocks.filter((block) => {
      if (block.length > 80 || block.includes('\n')) return true;
      const repeated = (counts.get(normalise(block)) ?? 0) >= threshold;
      if (repeated) affected++;
      return !repeated;
    });
    return { text: kept.join('\n\n'), affected };
  }

  private fixSpacing(text: string): StepResult {
    let affected = 0;
    const out = text
      .replace(/[ \t]{2,}/g, () => {
        affected++;
        return ' ';
      })
      .replace(/ +([,.;:!?])(?=\s|$)/g, (_match, punctuation: string) => {
        affected++;
        return punctuation;
      });
    return { text: out, affected };
  }

  private removeDuplicateBlocks(text: string): StepResult {
    let affected = 0;
    const out: string[] = [];
    for (const block of this.blocks(text)) {
      if (out.length && out[out.length - 1].trim() === block.trim() && block.trim()) {
        affected++;
        continue;
      }
      out.push(block);
    }
    return { text: out.join('\n\n'), affected };
  }

  private removeEmptyHeadings(text: string): StepResult {
    let affected = 0;
    const out = text.replace(/^#{1,6}\s*$/gm, () => {
      affected++;
      return '';
    });
    return { text: out, affected };
  }

  private tidyBlankLines(text: string): StepResult {
    let affected = 0;
    const out = text
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, () => {
        affected++;
        return '\n\n';
      })
      .trim();
    return { text: `${out}\n`, affected };
  }
}
