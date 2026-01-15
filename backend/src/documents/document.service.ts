// src/modules/document/document.service.ts
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
import { CloudinaryDocumentService } from './cloudinary-document.service';
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
import { RedisCacheService } from 'src/queues/cache/redis-cache.service';

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
    private readonly cloudinaryService: CloudinaryDocumentService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async generateDocumentSync(
    projectId: string,
    generateDto: GenerateDocumentDto,
    redisCache: RedisCacheService, // Changed from imageCache: Map
  ): Promise<{
    message: string;
    jobId: string;
    documentId: string;
    filename: string;
    url: string;
  }> {
    let project: Project | null = null;
    let chapters: any[] | null = null;
    let translation: Translation | null = null;
    let buffer: Buffer | null = null;

    try {
      project = await this.projectRepository.findOne({
        where: { id: projectId },
        relations: ['chapters', 'images'],
      });

      if (!project) {
        throw new NotFoundException(`Project with ID ${projectId} not found`);
      }

      if (!project.chapters || project.chapters.length === 0) {
        throw new BadRequestException(
          'Project has no content. Generate content first.',
        );
      }

      const job = this.jobRepository.create({
        projectId,
        type:
          generateDto.type === DocumentType.PDF
            ? JobType.PDF_GENERATION
            : JobType.DOCX_GENERATION,
        status: JobStatus.IN_PROGRESS,
        progress: 0,
        startedAt: new Date(),
        data: generateDto,
      });
      await this.jobRepository.save(job);

      // Get content based on language
      chapters = [...project.chapters];
      let title = project.title;
      let subtitle = project.subtitle;

      if (generateDto.language !== Language.ENGLISH) {
        translation = await this.translationRepository.findOne({
          where: { projectId, language: generateDto.language },
        });

        if (translation) {
          title = translation.title;
          subtitle = translation.subtitle;
          const translatedChapters = translation.content as any[];
          chapters = chapters.map((ch, index) => ({
            ...ch,
            content: translatedChapters[index]?.content || ch.content,
            title: translatedChapters[index]?.title || ch.title,
          }));
        }
      }

      job.progress = 20;
      await this.jobRepository.save(job);

      // Generate document buffer - pass Redis cache
      let result: { buffer: Buffer; filename: string };

      if (generateDto.type === DocumentType.PDF) {
        this.logger.log(
          `Generating PDF for ${title} in ${generateDto.language}...`,
        );
        result = await this.pdfService.generatePDFBuffer(
          title,
          subtitle,
          project.author,
          chapters,
          generateDto.includeImages ? project.images : [],
          redisCache, // Pass Redis service
        );
      } else {
        this.logger.log(
          `Generating DOCX for ${title} in ${generateDto.language}...`,
        );
        result = await this.docxService.generateDOCXBuffer(
          title,
          subtitle,
          project.author,
          chapters,
          generateDto.includeImages ? project.images : [],
          redisCache, // Pass Redis service
        );
      }

      buffer = result.buffer;

      job.progress = 50;
      await this.jobRepository.save(job);

      // Upload to Cloudinary
      this.logger.log(`Uploading ${result.filename} to Cloudinary...`);
      const cloudinaryResult = await this.cloudinaryService.uploadDocument(
        buffer,
        result.filename,
      );

      job.progress = 80;
      await this.jobRepository.save(job);

      // Save document record
      const document = this.documentRepository.create({
        projectId,
        type: generateDto.type,
        language: generateDto.language,
        filename: result.filename,
        url: cloudinaryResult.url,
        storageKey: cloudinaryResult.publicId,
        size: cloudinaryResult.size,
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
        url: cloudinaryResult.url,
        size: cloudinaryResult.size,
      };
      await this.jobRepository.save(job);

      this.eventEmitter.emit('document.generated', {
        projectId,
        documentId: document.id,
        type: generateDto.type,
        language: generateDto.language,
        url: cloudinaryResult.url,
      });

      this.logger.log(
        `Document generated and uploaded: ${result.filename} -> ${cloudinaryResult.url}`,
      );

      return {
        message: 'Document generated successfully',
        jobId: job.id,
        documentId: document.id,
        filename: result.filename,
        url: cloudinaryResult.url,
      };
    } catch (error) {
      this.logger.error(`Document generation failed:`, error);
      throw error;
    } finally {
      // CRITICAL: Clear all references
      project = null;
      chapters = null;
      translation = null;
      buffer = null;

      if (global.gc) {
        global.gc();
      }
    }
  }

  async generateAllDocumentsSequential(
    projectId: string,
    bulkDto: BulkGenerateDocumentsDto,
    redisCache: RedisCacheService,
  ) {
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    const results: Array<{
      type: DocumentType;
      language: Language;
      jobId: string;
      documentId: string;
      filename: string;
      url: string;
    }> = [];

    const totalDocs = bulkDto.types.length * bulkDto.languages.length;
    let completedCount = 0;

    this.logger.log(
      `[${projectId}] Starting sequential generation of ${totalDocs} documents...`,
    );

    this.logMemoryUsage('Initial');

    // Generate documents one at a time
    for (const type of bulkDto.types) {
      for (const language of bulkDto.languages) {
        try {
          completedCount++;

          this.logMemoryUsage(`Before ${type}-${language}`);

          this.logger.log(
            `[${projectId}] Generating ${type} for ${language} (${completedCount}/${totalDocs})...`,
          );

          const result = await this.generateDocumentSync(
            projectId,
            {
              type,
              language,
              includeImages: bulkDto.includeImages ?? true,
            },
            redisCache,
          );

          results.push({
            type,
            language,
            jobId: result.jobId,
            documentId: result.documentId,
            filename: result.filename,
            url: result.url,
          });

          this.logger.log(
            `[${projectId}] ✓ Completed ${type} for ${language} (${completedCount}/${totalDocs})`,
          );

          // Force garbage collection
          if (global.gc) {
            this.logger.log('Forcing garbage collection...');
            global.gc();
          }

          this.logMemoryUsage(`After ${type}-${language}`);

          // Delay between documents
          if (completedCount < totalDocs) {
            this.logger.log('Waiting 5 seconds for memory cleanup...');
            await this.delay(5000);
          }
        } catch (error) {
          this.logger.error(
            `[${projectId}] Failed to generate ${type} for ${language}:`,
            error,
          );
          throw error;
        }
      }
    }

    this.logger.log(
      `[${projectId}] All ${totalDocs} documents generated successfully`,
    );

    return {
      message: `Successfully generated ${results.length} documents`,
      documents: results,
      total: results.length,
    };
  }

  private logMemoryUsage(label: string): void {
    const used = process.memoryUsage();
    this.logger.log(
      `[Memory ${label}] Heap: ${Math.round(used.heapUsed / 1024 / 1024)} MB / ${Math.round(used.heapTotal / 1024 / 1024)} MB | RSS: ${Math.round(used.rss / 1024 / 1024)} MB`,
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    await this.cloudinaryService.deleteDocument(document.storageKey);
    await this.documentRepository.remove(document);
    this.logger.log(`Document deleted: ${document.filename}`);
  }
}
