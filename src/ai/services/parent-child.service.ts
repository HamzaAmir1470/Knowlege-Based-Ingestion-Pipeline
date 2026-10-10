import { Injectable } from '@nestjs/common';
import { ChildChunk, ParentChunk } from '../interfaces/ingestion.types';
import { MarkdownSection, splitIntoSections } from '../utils/markdown.util';
import { estimateTokens, pad, packParagraphs } from '../utils/text.util';
import { RecursiveChunkerService } from './recursive-chunker.service';

export interface ParentChildOptions {
  parentHeadingLevel: number;
  parentMax: number;
  childSize: number;
  childOverlap: number;
}

/**
 * Stage 7: parent-child structure for retrieval.
 *
 *   Parent  = a whole section (big, full context, sent to the LLM later)
 *   Child   = a small chunk inside that section (precise, used for search later)
 *
 * In the next RAG video we embed the children, find the best child for a question,
 * then return its parent so the LLM sees the full section. Today we only build the tree.
 */
@Injectable()
export class ParentChildService {
  constructor(private readonly recursiveChunker: RecursiveChunkerService) {}

  build(markdown: string, options: ParentChildOptions): ParentChunk[] {
    const groups = this.groupSectionsIntoParents(splitIntoSections(markdown), options.parentHeadingLevel);
    const parents: ParentChunk[] = [];

    for (const group of groups) {
      const parts = group.text.length > options.parentMax ? packParagraphs(group.text, options.parentMax) : [group.text];

      parts.forEach((partMarkdown, partIndex) => {
        const parentId = `parent-${pad(parents.length + 1)}`;
        const title = parts.length > 1 ? `${group.title} (part ${partIndex + 1})` : group.title;

        const children: ChildChunk[] = this.recursiveChunker
          .chunk(partMarkdown, { chunkSize: options.childSize, overlap: options.childOverlap })
          .map((chunk, i) => ({
            id: `${parentId}-child-${pad(i + 1)}`,
            parentId,
            index: i,
            content: chunk.content,
            charCount: chunk.charCount,
            tokenEstimate: estimateTokens(chunk.content),
          }));

        parents.push({
          id: parentId,
          title,
          headingPath: group.headingPath,
          markdown: partMarkdown,
          charCount: partMarkdown.length,
          childChunks: children,
        });
      });
    }
    return parents;
  }

  /**
   * A new parent starts at every heading up to `parentHeadingLevel`.
   * Deeper headings (###, ####) stay inside the current parent.
   */
  private groupSectionsIntoParents(sections: MarkdownSection[], parentLevel: number) {
    const groups: { title: string; headingPath: string[]; text: string }[] = [];

    for (const section of sections) {
      const startsNewParent = section.startLevel > 0 && section.startLevel <= parentLevel;
      const current = groups[groups.length - 1];

      if (!current || startsNewParent) {
        const topPath = section.headingPath.slice(0, parentLevel);
        groups.push({
          title: topPath[topPath.length - 1] ?? 'Introduction',
          headingPath: topPath,
          text: section.text,
        });
      } else {
        current.text += `\n\n${section.text}`;
      }
    }
    return groups;
  }
}
