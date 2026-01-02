import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PdfService } from './pdf.service';
import { DocxService } from './docx.service';
import {
  GenerateDocumentDto,
  BulkGenerateDocumentsDto,
} from './dto/generate-document.dto';
import {
  Document,
  DocumentType,
  DocumentStatus,
  Project,
  Chapter,
  Translation,
  Language,
  Job,
  JobType,
  JobStatus,
} from 'src/DB/entities';

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Chapter)
    private readonly chapterRepository: Repository<Chapter>,
    @InjectRepository(Translation)
    private readonly translationRepository: Repository<Translation>,
    @InjectRepository(Job)
    private readonly jobRepository: Repository<Job>,
    private readonly pdfService: PdfService,
    private readonly docxService: DocxService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async generateDocument(projectId: string, generateDto: GenerateDocumentDto) {
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
      relations: ['chapters'],
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    if (!project.chapters || project.chapters.length === 0) {
      throw new BadRequestException(
        'Project has no content. Generate content first.',
      );
    }

    // Create job
    const job = this.jobRepository.create({
      projectId,
      type:
        generateDto.type === DocumentType.PDF
          ? JobType.PDF_GENERATION
          : JobType.DOCX_GENERATION,
      status: JobStatus.PENDING,
      progress: 0,
      data: generateDto,
    });
    await this.jobRepository.save(job);

    // Start generation
    this.generateDocumentBackground(projectId, generateDto, job.id);

    return {
      message: `${generateDto.type} generation started`,
      jobId: job.id,
      projectId,
      type: generateDto.type,
      language: generateDto.language,
    };
  }

  private async generateDocumentBackground(
    projectId: string,
    generateDto: GenerateDocumentDto,
    jobId: string,
  ) {
    const job = await this.jobRepository.findOne({ where: { id: jobId } });

    if (!job) {
      this.logger.error(`Job with ID ${jobId} not found`);
      return;
    }

    try {
      job.status = JobStatus.IN_PROGRESS;
      job.startedAt = new Date();
      await this.jobRepository.save(job);

      const project = await this.projectRepository.findOne({
        where: { id: projectId },
        relations: ['chapters', 'images'],
      });

      if (!project) {
        this.logger.error(
          `Project with ID ${projectId} not found during generation update`,
        );
        return;
      }

      // Get content based on language
      let chapters = project.chapters;
      let title = project.title;
      let subtitle = project.subtitle;

      if (generateDto.language !== Language.ENGLISH) {
        const translation = await this.translationRepository.findOne({
          where: { projectId, language: generateDto.language },
        });

        if (translation) {
          title = translation.title;
          subtitle = translation.subtitle;
          // Use translated chapters from translation content
          const translatedChapters = translation.content as any[];
          chapters = chapters.map((ch, index) => ({
            ...ch,
            content: translatedChapters[index]?.content || ch.content,
            title: translatedChapters[index]?.title || ch.title,
          }));
        }
      }

      job.progress = 30;
      await this.jobRepository.save(job);

      let result: { filename: string; filepath: string; size: number };

      // Generate document
      if (generateDto.type === DocumentType.PDF) {
        this.logger.log(
          `Generating PDF for ${title} in ${generateDto.language}...`,
        );
        result = await this.pdfService.generatePDF(
          title,
          subtitle,
          project.author,
          chapters,
          generateDto.includeImages ? project.images : [],
        );
      } else {
        this.logger.log(
          `Generating DOCX for ${title} in ${generateDto.language}...`,
        );
        result = await this.docxService.generateDOCX(
          title,
          subtitle,
          project.author,
          chapters,
          generateDto.includeImages ? project.images : [],
        );
      }

      job.progress = 80;
      await this.jobRepository.save(job);

      // Save document record
      const document = this.documentRepository.create({
        projectId,
        type: generateDto.type,
        language: generateDto.language,
        filename: result.filename,
        url: `/storage/${result.filename}`,
        storageKey: result.filepath,
        size: result.size,
        status: DocumentStatus.COMPLETED,
      });
      await this.documentRepository.save(document);

      // Complete job
      job.status = JobStatus.COMPLETED;
      job.progress = 100;
      job.completedAt = new Date();
      job.result = {
        documentId: document.id,
        filename: result.filename,
        size: result.size,
      };
      await this.jobRepository.save(job);

      this.eventEmitter.emit('document.generated', {
        projectId,
        documentId: document.id,
        type: generateDto.type,
        language: generateDto.language,
      });

      this.logger.log(`Document generated: ${result.filename}`);
    } catch (error) {
      this.logger.error(`Document generation failed:`, error);

      job.status = JobStatus.FAILED;
      job.error = error.message;
      job.completedAt = new Date();
      await this.jobRepository.save(job);
    }
  }

  async generateAllDocuments(
    projectId: string,
    bulkDto: BulkGenerateDocumentsDto,
  ) {
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }
    type JobResult = {
      message: string;
      jobId: string;
      projectId: string;
      type: DocumentType;
      language: Language;
    };

    const jobs: JobResult[] = [];

    for (const type of bulkDto.types) {
      for (const language of bulkDto.languages) {
        const result = await this.generateDocument(projectId, {
          type,
          language,
          includeImages: bulkDto.includeImages ?? true,
        });
        jobs.push(result);
      }
    }

    return {
      message: `Started generation of ${jobs.length} documents`,
      jobs,
      total: jobs.length,
    };
  }

  async findAll(projectId: string) {
    return await this.documentRepository.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string) {
    const document = await this.documentRepository.findOne({
      where: { id },
    });

    if (!document) {
      throw new NotFoundException(`Document with ID ${id} not found`);
    }

    return document;
  }

  async remove(id: string) {
    const document = await this.findOne(id);

    // Delete physical file
    if (document.type === DocumentType.PDF) {
      await this.pdfService.deletePDF(document.storageKey);
    } else {
      await this.docxService.deleteDOCX(document.storageKey);
    }

    // Delete database record
    await this.documentRepository.remove(document);
  }
}
