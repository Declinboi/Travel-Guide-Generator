import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookGeneratorService } from './book-generator.service';
import { Project } from 'src/DB/entities/project.entity';
import { Job } from 'src/DB/entities/job.entity';
import { ProjectModule } from 'src/project/project.module';
import { ContentModule } from 'src/content/content.module';
import { TranslationModule } from 'src/translation/translation.module';
import { DocumentModule } from 'src/documents/document.module';
import { ImageModule } from 'src/images/image.module';
import { BookController } from './book.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Project]),

    ProjectModule,
    ContentModule,
    TranslationModule,
    DocumentModule,
    ImageModule,
  ],
  controllers: [BookController],
  providers: [BookGeneratorService],
  exports: [BookGeneratorService],
})
export class BookGeneratorModule {}
