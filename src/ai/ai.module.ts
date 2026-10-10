import { BadRequestException, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AiController } from './ai.controller';
import { GeminiSummaryService } from './services/gemini-summary.service';
import { IngestionPipelineService } from './services/ingestion-pipeline.service';
import { MarkdownConverterService } from './services/markdown-converter.service';
import { MetadataExtractorService } from './services/metadata-extractor.service';
import { ParentChildService } from './services/parent-child.service';
import { PdfParserService } from './services/pdf-parser.service';
import { RecursiveChunkerService } from './services/recursive-chunker.service';
import { SemanticChunkerService } from './services/semantic-chunker.service';
import { TextCleanerService } from './services/text-cleaner.service';

@Module({
  imports: [
    // Multer settings come from .env, so the upload limit is configurable without code changes.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: memoryStorage(),
        limits: { fileSize: config.getOrThrow<number>('upload.maxFileSizeMb') * 1024 * 1024 },
        fileFilter: (_req, file, callback) => {
          const looksLikePdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
          if (looksLikePdf) callback(null, true);
          else callback(new BadRequestException('Only PDF files are accepted.'), false);
        },
      }),
    }),
  ],
  controllers: [AiController],
  providers: [
    PdfParserService,
    MarkdownConverterService,
    MetadataExtractorService,
    TextCleanerService,
    RecursiveChunkerService,
    SemanticChunkerService,
    ParentChildService,
    GeminiSummaryService,
    IngestionPipelineService,
  ],
})
export class AiModule {}
