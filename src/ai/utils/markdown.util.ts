/**
 * Markdown helpers. The pipeline only needs a tiny subset of Markdown:
 * headings, paragraphs, lists, code fences and tables. Parsing that subset ourselves keeps
 * the project dependency-free and lets beginners read every line.
 */

export const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
export const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;

export type BlockType = 'heading' | 'paragraph' | 'list' | 'code' | 'table';

export interface MarkdownBlock {
  type: BlockType;
  text: string;
  /** Heading level (1 to 6). Only set for headings. */
  level?: number;
}

export interface MarkdownSection {
  /** Titles from the top heading down to this section's own heading. */
  headingPath: string[];
  /** Level of the section's own (last) heading. 0 means text before the first heading. */
  level: number;
  /** Level of the first heading in `text`. Differs from `level` when empty parents were merged in. */
  startLevel: number;
  /** Heading lines plus body, ready to be chunked. */
  text: string;
}

/** Turns Markdown into an ordered list of blocks. Blank lines separate blocks. */
export function parseBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let current: MarkdownBlock | null = null;
  let inCode = false;

  const flush = () => {
    if (current && current.text.trim()) blocks.push({ ...current, text: current.text.trimEnd() });
    current = null;
  };
  const append = (type: BlockType, line: string) => {
    if (current && current.type === type) current.text += `\n${line}`;
    else {
      flush();
      current = { type, text: line };
    }
  };

  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (!inCode) {
        flush();
        current = { type: 'code', text: line };
        inCode = true;
      } else {
        if (current) current.text += `\n${line}`;
        flush();
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      if (current) current.text += `\n${line}`;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(HEADING_LINE);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', text: line.trim(), level: heading[1].length });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) append('table', line);
    else if (LIST_ITEM.test(line)) append('list', line);
    else if (current && current.type === 'list' && /^\s+\S/.test(line)) current.text += `\n${line}`;
    else append('paragraph', line);
  }
  flush();
  return blocks;
}

/**
 * Splits a document into sections, one per heading.
 * A heading with no body of its own (for example "# Title" directly followed by "## Intro")
 * is merged into the next section so we never create a chunk that is only a heading.
 */
export function splitIntoSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const stack: { level: number; title: string }[] = [];

  let headingLines: string[] = [];
  let startLevel = 0;
  let level = 0;
  let path: string[] = [];
  let body: string[] = [];

  const flush = () => {
    const bodyText = body.join('\n').trim();
    if (!bodyText) return; // heading-only: keep headingLines for the next section
    sections.push({
      headingPath: path,
      level,
      startLevel,
      text: [...headingLines, bodyText].join('\n\n'),
    });
    headingLines = [];
    body = [];
    startLevel = 0;
  };

  let inCode = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    const heading = !inCode ? line.match(HEADING_LINE) : null;

    if (heading) {
      flush();
      const headingLevel = heading[1].length;
      while (stack.length && stack[stack.length - 1].level >= headingLevel) stack.pop();
      stack.push({ level: headingLevel, title: heading[2] });
      path = stack.map((s) => s.title);
      level = headingLevel;
      if (headingLines.length === 0) startLevel = headingLevel;
      headingLines.push(line.trim());
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();

  // Trailing heading with no body at all: keep it so no text is lost.
  if (headingLines.length) {
    sections.push({ headingPath: path, level, startLevel, text: headingLines.join('\n\n') });
  }
  return sections;
}

/** Strips Markdown markers so a title or heading can be shown as plain text. */
export const stripMarkdown = (text: string): string =>
  text.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').trim();
