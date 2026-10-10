/**
 * Central place that reads environment variables.
 * Every value has a safe default, so the app starts even with a minimal .env file.
 * Services read these values with ConfigService, for example:
 *   config.getOrThrow<number>('chunking.recursiveSize')
 */
const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toFloat = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

export default () => ({
  port: toInt(process.env.PORT, 3000),
  upload: {
    maxFileSizeMb: toInt(process.env.MAX_FILE_SIZE_MB, 10),
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    maxInputChars: toInt(process.env.GEMINI_MAX_INPUT_CHARS, 120_000),
  },
  chunking: {
    recursiveSize: toInt(process.env.CHUNK_SIZE, 800),
    recursiveOverlap: toInt(process.env.CHUNK_OVERLAP, 100),
    semanticMin: toInt(process.env.SEMANTIC_MIN_CHARS, 300),
    semanticMax: toInt(process.env.SEMANTIC_MAX_CHARS, 1200),
    semanticThreshold: toFloat(process.env.SEMANTIC_SIMILARITY_THRESHOLD, 0.12),
    parentHeadingLevel: toInt(process.env.PARENT_HEADING_LEVEL, 2),
    parentMax: toInt(process.env.PARENT_MAX_CHARS, 3000),
    childSize: toInt(process.env.CHILD_CHUNK_SIZE, 400),
    childOverlap: toInt(process.env.CHILD_CHUNK_OVERLAP, 50),
  },
  pipeline: {
    stageDelayMs: toInt(process.env.STAGE_DELAY_MS, 450),
  },
});
