import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // The dashboard is plain HTML, CSS and JS in /public. Nest serves it at "/".
  app.useStaticAssets(join(__dirname, '..', 'public'));

  const port = app.get(ConfigService).getOrThrow<number>('port');
  await app.listen(port);
  new Logger('Bootstrap').log(`Dashboard ready at http://localhost:${port}`);
}

bootstrap();
