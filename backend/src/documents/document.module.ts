import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { PdfService } from './pdf.service';
import { DocxService } from './docx.service';
import { Document,Project,Chapter,Translation, Job,} from 'src/DB/entities';

@Module({
  imports: [TypeOrmModule.forFeature([Document, Project, Chapter, Translation, Job])],
  controllers: [DocumentController],
  providers: [DocumentService, PdfService, DocxService],
  exports: [DocumentService, PdfService, DocxService],
})
export class DocumentModule {}