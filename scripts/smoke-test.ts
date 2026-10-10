/**
 * Runs the whole pipeline on a PDF without starting the web server.
 *   npm run smoke
 *   npm run smoke -- path/to/file.pdf
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { AppModule } from '../src/app.module';
import { IngestionPipelineService } from '../src/ai/services/ingestion-pipeline.service';

async function main() {
  process.env.STAGE_DELAY_MS = '0';
  const path = process.argv[2] ?? join(__dirname, '..', 'public', 'sample', 'rag-fundamentals.pdf');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const pipeline = app.get(IngestionPipelineService);

  const buffer = readFileSync(path);
  const result = await pipeline.run(
    { originalname: basename(path), mimetype: 'application/pdf', size: buffer.length, buffer },
    (event) => {
      if (event.type === 'stage' && event.status !== 'running') {
        console.log(`${event.status.padEnd(6)} ${event.stage.padEnd(12)} ${String(event.durationMs).padStart(5)}ms  ${event.detail ?? ''}`);
      }
    },
  );

  console.log('\nMetadata:', JSON.stringify(result.metadata, null, 2));
  console.log('\nCleaning report:', result.cleaned.report.steps.map((s) => `${s.name}: ${s.affected}`).join(' | '));
  console.log('\nStats:', JSON.stringify(result.stats, null, 2));
  console.log('\nSummary error:', result.summaryError);
  console.log('\n--- Markdown (first 1500 chars) ---\n' + result.cleaned.markdown.slice(0, 1500));
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
