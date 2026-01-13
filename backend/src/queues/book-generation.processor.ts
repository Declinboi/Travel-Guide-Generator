// src/queue/processors/book-generation.processor.ts
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BookGenerationJobData } from '../queues/book-generation.queue';
import {
  Project,
  ProjectStatus,
  JobStatus,
  Language,
  Chapter,
} from '../DB/entities';
import { ContentService } from '../content/content.service';
import { TranslationService } from '../translation/translation.service';
import { DocumentService } from '../documents/document.service';
import { ImageService } from '../images/image.service';
import { DocumentType } from '../DB/entities/document.entity';

@Processor('book-generation', {
  concurrency: 1, // CRITICAL: Reduced from 2 to 1 to prevent memory overflow
})
export class BookGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(BookGenerationProcessor.name);

  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Chapter)
    private readonly chapterRepository: Repository<Chapter>,
    private readonly contentService: ContentService,
    private readonly translationService: TranslationService,
    private readonly documentService: DocumentService,
    private readonly imageService: ImageService,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job<BookGenerationJobData>): Promise<any> {
    const { projectId, createBookDto, files } = job.data;
    let processedFiles: typeof files | null = files; // Create mutable copy for cleanup

    try {
      this.logger.log(`[${projectId}] Starting book generation job ${job.id}`);

      // CRITICAL: Don't load full project with all chapters - just get basic info
      const project = await this.projectRepository.findOne({
        where: { id: projectId },
        select: ['id', 'status', 'title'],
      });

      if (!project) {
        throw new Error(`Project ${projectId} not found`);
      }

      // STEP 1: Generate Content (0-40%)
      await this.updateJobProgress(job, 0, 'Checking content status');

      const chapterCount = await this.chapterRepository.count({
        where: { projectId },
      });

      if (chapterCount === 0) {
        await this.updateJobProgress(job, 5, 'Generating content');
        await this.updateProjectStatus(projectId, ProjectStatus.GENERATING_CONTENT);

        this.logger.log(`[${projectId}] Step 1: Generating content...`);
        const contentResult = await this.contentService.generateTravelGuideBook(
          projectId,
          {
            title: createBookDto.title,
            subtitle: createBookDto.subtitle,
            author: createBookDto.author,
            numberOfChapters: 10,
          },
        );

        await this.waitForJobCompletion(contentResult.jobId);
        await this.updateJobProgress(job, 40, 'Content generated');
        this.logger.log(`[${projectId}] Content generation completed`);
        
        await this.validateChaptersProjectId(projectId);
        this.forceGarbageCollection();
      } else {
        this.logger.log(`[${projectId}] Content already exists (${chapterCount} chapters)`);
        await this.updateJobProgress(job, 40, 'Content already exists');
        await this.validateChaptersProjectId(projectId);
      }

      // STEP 2: Process Images (40-50%)
      const existingImageCount = await this.dataSource
        .createQueryBuilder()
        .select('COUNT(*)', 'count')
        .from('images', 'i')
        .where('i.projectId = :projectId', { projectId })
        .getRawOne();

      if (existingImageCount.count === '0' && processedFiles?.images && processedFiles.images.length > 0) {
        await this.updateJobProgress(job, 40, 'Processing images');
        this.logger.log(`[${projectId}] Step 2: Processing ${processedFiles.images.length} images...`);
        
        await this.processImages(projectId, createBookDto, processedFiles.images);

        if (processedFiles?.mapImage && processedFiles.mapImage.length > 0) {
          this.logger.log(`[${projectId}] Processing map image...`);
          const mapFile = this.bufferToMulterFile(processedFiles.mapImage[0]);
          await this.imageService.uploadImage(projectId, mapFile, {
            isMap: true,
            caption: createBookDto.mapCaption,
          });
        }
        
        await this.updateJobProgress(job, 50, 'Images processed');
        this.forceGarbageCollection();
      } else {
        this.logger.log(`[${projectId}] Images already uploaded, skipping`);
        await this.updateJobProgress(job, 50, 'Images already exist');
      }

      // STEP 3: Translate (50-70%)
      await this.updateProjectStatus(projectId, ProjectStatus.TRANSLATING);

      await this.updateJobProgress(job, 50, 'Starting translations');
      this.logger.log(`[${projectId}] Step 3: Translating to 4 languages...`);

      const targetLanguages = [
        Language.GERMAN,
        Language.FRENCH,
        Language.SPANISH,
        Language.ITALIAN,
      ];

      await this.translateSequentially(projectId, targetLanguages, job);
      await this.updateJobProgress(job, 70, 'Translations completed');

      this.forceGarbageCollection();

      // STEP 4: Generate Documents (70-100%)
      await this.updateProjectStatus(projectId, ProjectStatus.GENERATING_DOCUMENTS);

      await this.updateJobProgress(job, 70, 'Generating documents');
      this.logger.log(`[${projectId}] Step 4: Generating 10 documents...`);

      await this.generateDocumentsSequentially(projectId, job);
      await this.updateJobProgress(job, 100, 'All documents generated');

      // COMPLETE
      await this.updateProjectStatus(projectId, ProjectStatus.COMPLETED);

      this.logger.log(`[${projectId}] ✅ Book generation completed!`);

      return {
        success: true,
        projectId,
        message: 'Book generation completed successfully',
      };
    } catch (error) {
      this.logger.error(`[${projectId}] Book generation failed:`, error);

      await this.updateProjectStatus(projectId, ProjectStatus.FAILED);

      throw error;
    } finally {
      // CRITICAL: Aggressive cleanup
      processedFiles = null;
      this.forceGarbageCollection();
    }
  }

  // CRITICAL FIX: Lightweight project status update without loading full entity
  private async updateProjectStatus(projectId: string, status: ProjectStatus): Promise<void> {
    await this.projectRepository
      .createQueryBuilder()
      .update(Project)
      .set({ status })
      .where('id = :id', { id: projectId })
      .execute();
  }

  // CRITICAL FIX: Validate chapters without loading all data
  private async validateChaptersProjectId(projectId: string): Promise<void> {
    try {
      // Find chapters with null projectId using query builder (no entity loading)
      const invalidChapters = await this.chapterRepository
        .createQueryBuilder('chapter')
        .select('chapter.id')
        .where('chapter.projectId IS NULL')
        .andWhere('chapter.project = :projectId', { projectId })
        .getMany();

      if (invalidChapters.length > 0) {
        this.logger.warn(
          `Found ${invalidChapters.length} chapters with null projectId for project ${projectId}`,
        );

        // Batch update all invalid chapters
        const chapterIds = invalidChapters.map(c => c.id);
        await this.chapterRepository
          .createQueryBuilder()
          .update(Chapter)
          .set({ projectId: projectId })
          .where('id IN (:...ids)', { ids: chapterIds })
          .execute();

        this.logger.log(
          `Fixed ${invalidChapters.length} chapters with missing projectId`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error validating chapters for project ${projectId}:`,
        error,
      );
      throw error;
    }
  }

  private async translateSequentially(
    projectId: string,
    targetLanguages: Language[],
    job: Job,
  ): Promise<void> {
    for (let i = 0; i < targetLanguages.length; i++) {
      const language = targetLanguages[i];
      const percent = 50 + Math.floor((i / targetLanguages.length) * 20);

      try {
        await this.updateJobProgress(
          job,
          percent,
          `Translating to ${language}`,
        );

        this.logger.log(`[${projectId}] Translating to ${language}...`);

        const result = await this.translationService.translateProject(
          projectId,
          {
            targetLanguage: language,
            maintainStyle: true,
          },
        );

        await this.waitForJobCompletion(result.jobId);
        this.logger.log(`[${projectId}] ✓ Completed ${language}`);

        // Validate after translation
        await this.validateChaptersProjectId(projectId);

        // CRITICAL: Aggressive memory cleanup between translations
        this.forceGarbageCollection();
        await this.delay(8000); // Increased delay for memory to stabilize
      } catch (error) {
        if (error.message?.includes('already exists')) {
          this.logger.log(
            `[${projectId}] Skipping ${language} - already exists`,
          );
        } else {
          throw error;
        }
      }
    }
  }

  private async generateDocumentsSequentially(
    projectId: string,
    job: Job,
  ): Promise<void> {
    const languages = [
      Language.ENGLISH,
      Language.GERMAN,
      Language.FRENCH,
      Language.SPANISH,
      Language.ITALIAN,
    ];
    const types = [DocumentType.PDF, DocumentType.DOCX];
    const totalDocs = languages.length * types.length;
    let completed = 0;

    // CRITICAL: Check existing docs without loading full entities
    const existingDocs = await this.dataSource
      .createQueryBuilder()
      .select('CONCAT(d.type, \'-\', d.language)', 'key')
      .from('documents', 'd')
      .where('d.projectId = :projectId', { projectId })
      .getRawMany();

    const existingKeys = new Set(existingDocs.map((doc) => doc.key));

    for (const language of languages) {
      for (const type of types) {
        const docKey = `${type}-${language}`;

        if (existingKeys.has(docKey)) {
          completed++;
          const percent = 70 + Math.floor((completed / totalDocs) * 30);
          await this.updateJobProgress(
            job,
            percent,
            `Skipping ${type} (${language}) - already exists (${completed}/${totalDocs})`,
          );
          this.logger.log(`[${projectId}] ✓ ${type}-${language} already exists`);
          continue;
        }

        completed++;
        const percent = 70 + Math.floor((completed / totalDocs) * 30);

        await this.updateJobProgress(
          job,
          percent,
          `Generating ${type} (${language}) - ${completed}/${totalDocs}`,
        );

        this.logger.log(`[${projectId}] Generating ${type} for ${language}...`);

        try {
          await this.documentService.generateDocumentSync(projectId, {
            type,
            language,
            includeImages: true,
          });

          this.logger.log(`[${projectId}] ✓ Completed ${type}-${language}`);
        } catch (error) {
          this.logger.error(
            `[${projectId}] Failed to generate ${type}-${language}:`,
            error.message,
          );
          // Continue with next document instead of failing entire job
        }

        // CRITICAL: Aggressive memory cleanup between documents
        this.forceGarbageCollection();
        await this.delay(3000);
      }
    }
  }

  private async processImages(
    projectId: string,
    createBookDto: any,
    images: any[],
  ) {
    const totalImages = images.length;
    const numberOfChapters = 10;

    let chapterNumbers = createBookDto.imageChapterNumbers;

    if (!chapterNumbers || chapterNumbers.length !== totalImages) {
      const mainChapters = Array.from(
        { length: numberOfChapters - 2 },
        (_, i) => i + 2,
      );
      chapterNumbers = [];
      for (let i = 0; i < totalImages; i++) {
        const chapterIndex = Math.floor(
          (i / totalImages) * mainChapters.length,
        );
        chapterNumbers.push(mainChapters[chapterIndex]);
      }
    }

    for (let i = 0; i < images.length; i++) {
      const caption = createBookDto.imageCaptions?.[i] || `Image ${i + 1}`;
      const chapterNumber = chapterNumbers[i];

      const file = this.bufferToMulterFile(images[i]);

      await this.imageService.uploadImage(projectId, file, {
        chapterNumber,
        caption,
        isMap: false,
      });

      this.logger.log(
        `Image ${i + 1}/${totalImages} uploaded to Chapter ${chapterNumber}`,
      );

      // CRITICAL: Clear file reference immediately after upload
      images[i] = null;
    }
  }

  private bufferToMulterFile(fileData: any): Express.Multer.File {
    if (!fileData) {
      throw new Error('Invalid file data');
    }

    let buffer: Buffer;
    
    if (fileData.buffer?.type === 'Buffer' && Array.isArray(fileData.buffer.data)) {
      buffer = Buffer.from(fileData.buffer.data);
    } else if (Buffer.isBuffer(fileData.buffer)) {
      buffer = fileData.buffer;
    } else {
      buffer = Buffer.from(fileData.buffer?.data || fileData.buffer);
    }

    return {
      buffer: buffer,
      originalname: fileData.originalname,
      mimetype: fileData.mimetype,
      fieldname: 'file',
      encoding: '7bit',
      size: buffer.length,
    } as Express.Multer.File;
  }

  private async waitForJobCompletion(jobId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const maxWaitTime = 600000; // 10 minutes
      const checkInterval = 5000;
      let elapsedTime = 0;

      const interval = setInterval(async () => {
        try {
          elapsedTime += checkInterval;

          if (elapsedTime >= maxWaitTime) {
            clearInterval(interval);
            reject(new Error(`Job ${jobId} timed out after 10 minutes`));
            return;
          }

          const status = await this.contentService.getGenerationStatus(jobId);

          if (status.status === JobStatus.COMPLETED) {
            clearInterval(interval);
            resolve();
          } else if (status.status === JobStatus.FAILED) {
            clearInterval(interval);
            reject(new Error(`Job ${jobId} failed`));
          }
        } catch (error) {
          clearInterval(interval);
          reject(error);
        }
      }, checkInterval);
    });
  }

  private forceGarbageCollection(): void {
    if (global.gc) {
      global.gc();
      this.logger.debug('Forced garbage collection');
    } else {
      this.logger.warn('Garbage collection not exposed. Run with --expose-gc');
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async updateJobProgress(
    job: Job,
    percent: number,
    step: string,
  ): Promise<void> {
    await job.updateProgress({ percent, step });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`Job ${job.id} completed successfully`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed:`, error);
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.log(`Job ${job.id} is now active`);
  }
}