/**
 * Small text helpers shared by the chunkers, the metadata extractor and the cleaner.
 * Everything here is pure: no Nest, no I/O. That keeps it easy to read and to unit test.
 */

export const STOPWORDS = new Set(
  (
    'a about above after again all also am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing down during each few for from further had has have having he her here hers him his how ' +
    'i if in into is it its itself just me more most my no nor not now of off on once only or other our out over own same ' +
    'she should so some such than that the their them then there these they this those through to too under until up ' +
    'very was we were what when where which while who whom why will with would you your yours however therefore thus ' +
    'may might must shall one two three use used using like many much often'
  ).split(' '),
);

const ABBREVIATIONS = [
  'e.g.', 'i.e.', 'etc.', 'vs.', 'fig.', 'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'sr.', 'jr.', 'no.', 'inc.', 'ltd.', 'approx.', 'al.',
];

export const countWords = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0);

/** Rough token estimate. English text averages about 4 characters per token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Splits text into sentences using punctuation followed by a capital letter or digit.
 * Known abbreviations (e.g., Dr., Fig.) are glued back to the next sentence.
 */
export function splitSentences(text: string): string[] {
  const rough = text
    .split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const sentences: string[] = [];
  for (const piece of rough) {
    const previous = sentences[sentences.length - 1];
    if (previous && ABBREVIATIONS.some((abbr) => previous.toLowerCase().endsWith(abbr))) {
      sentences[sentences.length - 1] = `${previous} ${piece}`;
    } else {
      sentences.push(piece);
    }
  }
  return sentences;
}

/** Packs sentences into pieces up to maxChars. Very long sentences are split on word boundaries. */
export function packSentences(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim()) pieces.push(buffer.trim());
    buffer = '';
  };

  for (const sentence of splitSentences(text)) {
    if (sentence.length > maxChars) {
      flush();
      pieces.push(...hardSplit(sentence, maxChars));
      continue;
    }
    if (buffer && buffer.length + 1 + sentence.length > maxChars) flush();
    buffer = buffer ? `${buffer} ${sentence}` : sentence;
  }
  flush();
  return pieces;
}

/** Packs paragraphs (separated by blank lines) into pieces up to maxChars. */
export function packParagraphs(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim()) pieces.push(buffer.trim());
    buffer = '';
  };

  for (const paragraph of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (paragraph.length > maxChars) {
      flush();
      pieces.push(...packSentences(paragraph, maxChars));
      continue;
    }
    if (buffer && buffer.length + 2 + paragraph.length > maxChars) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return pieces;
}

/** Last resort: cut on word boundaries, and on raw characters if a single word is too long. */
export function hardSplit(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let buffer = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > maxChars) {
      if (buffer) pieces.push(buffer);
      buffer = '';
      for (let i = 0; i < word.length; i += maxChars) pieces.push(word.slice(i, i + maxChars));
      continue;
    }
    if (buffer && buffer.length + 1 + word.length > maxChars) {
      pieces.push(buffer);
      buffer = word;
    } else {
      buffer = buffer ? `${buffer} ${word}` : word;
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

/** Very light stemmer so "chunks" and "chunking" count as the same keyword. */
export function stem(word: string): string {
  return word
    .replace(/(ies)$/, 'y')
    .replace(/(ing|ed|es|s)$/, '')
    .replace(/(.)\1$/, '$1');
}

/** Lowercase keyword set without stopwords. Used by metadata and semantic grouping. */
export function extractKeywordSet(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? [];
  const result = new Set<string>();
  for (const word of words) {
    if (!STOPWORDS.has(word)) result.add(stem(word));
  }
  return result;
}

/** Overlap coefficient: shared keywords divided by the size of the smaller set (0 to 1). */
export function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.min(a.size, b.size);
}

/** Top N most frequent keywords, original word form kept for display. */
export function topKeywords(text: string, limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

export function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export const pad = (value: number, width = 3): string => String(value).padStart(width, '0');

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
