import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TranslationService } from './translation.service';
import { TranslationController } from './translation.controller';
import { GeminiTranslationService } from './gemini-translation.service';
import { Chapter, Job, Project, Translation } from 'src/DB/entities';

@Module({
  imports: [TypeOrmModule.forFeature([Translation, Project, Chapter, Job])],
  controllers: [TranslationController],
  providers: [TranslationService, GeminiTranslationService],
  exports: [TranslationService, GeminiTranslationService],
})
export class TranslationModule {}