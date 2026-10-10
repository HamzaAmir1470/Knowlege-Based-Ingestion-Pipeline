import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module';
import appConfig from './config/app.config';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }), AiModule],
})
export class AppModule {}
