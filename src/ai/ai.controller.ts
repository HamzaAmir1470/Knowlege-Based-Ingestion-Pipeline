import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { PipelineEvent } from './interfaces/ingestion.types';
import { IngestionPipelineService } from './services/ingestion-pipeline.service';

@Controller('ai')
export class AiController {
  constructor(private readonly pipeline: IngestionPipelineService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /** Plain JSON endpoint. Waits for every stage and returns the full result. */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file?: Express.Multer.File) {
    return this.pipeline.run(this.requireFile(file));
  }

  /**
   * Streaming endpoint used by the dashboard.
   * It sends one JSON object per line (NDJSON) as each stage starts and finishes,
   * so the browser can update the timeline in real time.
   */
  @Post('upload/stream')
  @UseInterceptors(FileInterceptor('file'))
  async uploadStream(@UploadedFile() file: Express.Multer.File | undefined, @Res() res: Response) {
    const pdf = this.requireFile(file);

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: PipelineEvent) => res.write(`${JSON.stringify(event)}\n`);
    try {
      await this.pipeline.run(pdf, send);
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : 'Processing failed.' });
    } finally {
      res.end();
    }
  }

  private requireFile(file?: Express.Multer.File): Express.Multer.File {
    if (!file) throw new BadRequestException('Attach a PDF in the "file" form field.');
    return file;
  }
}
