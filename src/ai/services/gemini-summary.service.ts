import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, Type } from '@google/genai';
import { GeminiSummary } from '../interfaces/ingestion.types';
import { sleep } from '../utils/text.util';

/**
 * Stage 8: send the cleaned Markdown to Gemini 2.5 Flash and get a structured summary back.
 * We ask for JSON with a response schema, so there is no fragile text parsing.
 */
@Injectable()
export class GeminiSummaryService {
  private readonly logger = new Logger(GeminiSummaryService.name);
  private client: GoogleGenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  async summarize(markdown: string, title: string): Promise<GeminiSummary> {
    const apiKey = this.config.get<string>('gemini.apiKey');
    if (!apiKey || apiKey.startsWith('your_')) {
      throw new Error('GEMINI_API_KEY is missing. Add your key to the .env file and restart the server.');
    }
    this.client ??= new GoogleGenAI({ apiKey });

    const model = this.config.getOrThrow<string>('gemini.model');
    const maxChars = this.config.getOrThrow<number>('gemini.maxInputChars');
    const input = markdown.length > maxChars ? `${markdown.slice(0, maxChars)}\n\n[Document truncated]` : markdown;

    const prompt = [
      'You summarize documents for a knowledge base.',
      'Read the Markdown document below and respond with JSON only.',
      '- summary: 3 to 5 sentences in plain language.',
      '- keyPoints: 4 to 6 short bullet points. Each one is a full sentence.',
      '- topics: 3 to 6 short topic labels.',
      '- documentType: one short label such as "technical guide", "research paper" or "report".',
      '',
      `Document title: ${title}`,
      '',
      '---',
      input,
    ].join('\n');

    const text = await this.generateWithRetry(model, prompt);
    try {
      const parsed = JSON.parse(text) as Partial<GeminiSummary>;
      return {
        summary: parsed.summary ?? '',
        keyPoints: parsed.keyPoints ?? [],
        topics: parsed.topics ?? [],
        documentType: parsed.documentType ?? 'document',
      };
    } catch {
      throw new Error('Gemini returned a response that was not valid JSON. Try again.');
    }
  }

  /** Gemini sometimes answers 503 when it is busy. Two quick retries solve most of those. */
  private async generateWithRetry(model: string, prompt: string, attempts = 3): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await this.client!.models.generateContent({
          model,
          contents: prompt,
          config: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                summary: { type: Type.STRING },
                keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
                topics: { type: Type.ARRAY, items: { type: Type.STRING } },
                documentType: { type: Type.STRING },
              },
              required: ['summary', 'keyPoints', 'topics', 'documentType'],
            },
          },
        });
        if (!response.text) throw new Error('Gemini returned an empty response.');
        return response.text;
      } catch (error) {
        lastError = error;
        this.logger.warn(`Gemini attempt ${attempt}/${attempts} failed: ${this.describe(error)}`);
        if (attempt < attempts) await sleep(800 * attempt);
      }
    }
    throw new Error(`Gemini request failed: ${this.describe(lastError)}`);
  }

  private describe(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 300 ? `${message.slice(0, 300)}...` : message;
  }
}
