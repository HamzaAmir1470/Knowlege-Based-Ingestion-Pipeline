import { Injectable } from '@nestjs/common';
import { Chunk } from '../interfaces/ingestion.types';
import { MarkdownBlock, parseBlocks, stripMarkdown } from '../utils/markdown.util';
import {
  countWords,
  estimateTokens,
  extractKeywordSet,
  overlapCoefficient,
  packSentences,
  pad,
  round,
} from '../utils/text.util';

export interface SemanticOptions {
  minChars: number;
  maxChars: number;
  /** Overlap coefficient below this value counts as a topic shift. */
  threshold: number;
}

interface Group {
  blocks: MarkdownBlock[];
  headingPath: string[];
  startReason: string;
  rules: Set<string>;
  length: number;
}

const TRANSITION_START =
  /^(however|therefore|thus|moreover|furthermore|additionally|in addition|also|for example|for instance|in contrast|on the other hand|as a result|consequently|similarly|this|these|that|those|it|they|such|because|but|and|so)\b/i;

/**
 * Stage 6: rule-based semantic chunking (no embeddings).
 *
 * We walk through the document block by block and decide: keep this block in the current chunk,
 * or start a new one? The decision uses plain rules a beginner can read:
 *
 *   Always split      a new heading starts a new topic (small ### sub-headings may stay with their parent).
 *   Always keep       a list or code block stays with the sentence that introduces it.
 *   Always keep       a block that starts with "However", "This", "For example" continues the last idea.
 *   Split             the chunk would exceed `maxChars`.
 *   Split             the chunk is at least `minChars` and the next block shares few keywords
 *                     with the last two blocks (a topic shift).
 *
 * Later in the course you can replace the keyword rule with embedding similarity.
 */
@Injectable()
export class SemanticChunkerService {
  chunk(markdown: string, options: SemanticOptions): Chunk[] {
    const { minChars, maxChars, threshold } = options;
    const blocks = parseBlocks(markdown);
    const groups: Group[] = [];

    let current: Group | null = null;
    let previousContent: MarkdownBlock | null = null;
    const headingStack: { level: number; title: string }[] = [];

    const startGroup = (reason: string): Group => {
      const group: Group = {
        blocks: [],
        headingPath: headingStack.map((h) => h.title),
        startReason: reason,
        rules: new Set(),
        length: 0,
      };
      groups.push(group);
      return group;
    };
    const add = (group: Group, block: MarkdownBlock) => {
      group.blocks.push(block);
      group.length += block.text.length + 2;
    };
    const hasBody = (group: Group) => group.blocks.some((b) => b.type !== 'heading');

    for (const block of blocks) {
      // Rule: a heading always opens a new topic.
      if (block.type === 'heading') {
        const level = block.level ?? 1;
        while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
        headingStack.push({ level, title: stripMarkdown(block.text) });

        // Top-level headings always start a new chunk. A small sub-heading (### and deeper)
        // stays with its parent section until the chunk has reached the minimum size.
        const smallSubsection = !!current && hasBody(current) && level >= 3 && current.length < minChars;
        if (!current || (hasBody(current) && !smallSubsection)) {
          current = startGroup(`New heading: "${stripMarkdown(block.text)}"`);
        } else if (smallSubsection) {
          current.rules.add('small subsection stays with its parent section');
        } else {
          current.headingPath = headingStack.map((h) => h.title);
        }
        add(current, block);
        previousContent = null;
        continue;
      }

      // An oversized block cannot fit anywhere. Split it by sentences.
      if (block.text.length > maxChars) {
        for (const part of packSentences(block.text, maxChars)) {
          const group = startGroup(current && hasBody(current) ? 'Oversized paragraph split by sentences' : current ? 'Heading kept with its text' : 'Start of document');
          if (current && !hasBody(current)) {
            // keep the heading we just saw with the first part
            group.blocks.push(...current.blocks);
            group.length += current.length;
            group.startReason = current.startReason;
            groups.splice(groups.indexOf(current), 1);
          }
          group.rules.add('oversized paragraph split on sentence boundaries');
          add(group, { type: 'paragraph', text: part });
          current = group;
        }
        previousContent = block;
        continue;
      }

      if (!current) current = startGroup('Start of document');
      if (!hasBody(current)) {
        add(current, block);
        previousContent = block;
        continue;
      }

      const decision = this.decide(current, block, previousContent, { minChars, maxChars, threshold });
      if (decision.split) {
        current = startGroup(decision.reason);
      } else if (decision.rule) {
        current.rules.add(decision.rule);
      }
      add(current, block);
      previousContent = block;
    }

    return this.mergeTinyGroups(groups, minChars, maxChars).map((group, index) => {
      const content = group.blocks.map((b) => b.text).join('\n\n').trim();
      return {
        id: `sem-${pad(index + 1)}`,
        index,
        content,
        headingPath: group.headingPath,
        charCount: content.length,
        wordCount: countWords(content),
        tokenEstimate: estimateTokens(content),
        strategy: 'semantic' as const,
        boundaryReason: group.startReason,
        groupingRules: [...group.rules],
      };
    });
  }

  private decide(
    group: Group,
    block: MarkdownBlock,
    previous: MarkdownBlock | null,
    opts: SemanticOptions,
  ): { split: boolean; reason: string; rule?: string } {
    if (group.length + block.text.length + 2 > opts.maxChars) {
      return { split: true, reason: `Size limit reached (${opts.maxChars} characters)` };
    }

    // Keep rules come first because they protect meaning.
    if (previous && /:\s*$/.test(previous.text)) return { split: false, reason: '', rule: 'text after a colon stays with its introduction' };
    if (block.type !== 'paragraph') return { split: false, reason: '', rule: `${block.type} stays with the paragraph before it` };
    if (TRANSITION_START.test(block.text)) return { split: false, reason: '', rule: 'transition word continues the previous idea' };
    if (block.text.length < 80) return { split: false, reason: '', rule: 'short paragraph stays with its neighbour' };

    if (group.length >= opts.minChars) {
      const recent = group.blocks.filter((b) => b.type !== 'heading').slice(-2).map((b) => b.text).join(' ');
      const similarity = overlapCoefficient(extractKeywordSet(recent), extractKeywordSet(block.text));
      if (similarity < opts.threshold) {
        return { split: true, reason: `Topic shift (keyword overlap ${round(similarity, 2)} is below ${opts.threshold})` };
      }
      return { split: false, reason: '', rule: 'shares keywords with the previous paragraphs' };
    }
    return { split: false, reason: '', rule: `chunk is below the ${opts.minChars} character minimum` };
  }

  /** A small leftover chunk is folded into the previous chunk when both sit under the same heading. */
  private mergeTinyGroups(groups: Group[], minChars: number, maxChars: number): Group[] {
    const result: Group[] = [];
    for (const group of groups) {
      const previous = result[result.length - 1];
      const sameSection = previous && previous.headingPath.join('>') === group.headingPath.join('>');
      const startsWithHeading = group.blocks[0]?.type === 'heading';
      if (previous && sameSection && !startsWithHeading && group.length < minChars && previous.length + group.length <= maxChars) {
        previous.blocks.push(...group.blocks);
        previous.length += group.length;
        group.rules.forEach((r) => previous.rules.add(r));
        previous.rules.add('small leftover merged into the previous chunk');
      } else {
        result.push(group);
      }
    }
    return result;
  }
}
