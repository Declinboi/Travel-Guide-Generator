import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentService } from './content.service';
import { ContentController } from './content.controller';
import { GeminiService } from './gemini.service';
import { Chapter } from 'src/DB/entities/chapter.entity';
import { Project } from 'src/DB/entities/project.entity';
import { Job } from 'src/DB/entities/job.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Chapter, Project, Job])],
  controllers: [ContentController],
  providers: [ContentService, GeminiService],
  exports: [ContentService, GeminiService],
})
export class ContentModule {}