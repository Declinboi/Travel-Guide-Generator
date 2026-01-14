// src/queues/book-generation.processor.ts
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BookGenerationJobData } from './book-generation.queue';
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
import axios from 'axios';

@Processor('book-generation', {
  concurrency: 1,
  limiter: {
    max: 1,
    duration: 1000,
  },
})
export class BookGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(BookGenerationProcessor.name);
  private imageCache: Map<string, Buffer> = new Map();

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

    this.logMemory('Job Start');

    try {
      this.logger.log(`[${projectId}] Starting book generation job ${job.id}`);

      // STEP 1: Generate Content (0-40%)
      await this.updateJobProgress(job, 0, 'Checking content status');

      const chapterCount = await this.chapterRepository.count({
        where: { projectId },
      });

      if (chapterCount === 0) {
        await this.updateJobProgress(job, 5, 'Generating content');
        await this.updateProjectStatus(
          projectId,
          ProjectStatus.GENERATING_CONTENT,
        );

        this.logger.log(`[${projectId}] Generating content...`);
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

        await this.validateAndFixChapters(projectId);
        this.extremeCleanup();
        this.logMemory('After Content Generation');
      } else {
        this.logger.log(
          `[${projectId}] Content exists (${chapterCount} chapters)`,
        );
        await this.updateJobProgress(job, 40, 'Content already exists');
        await this.validateAndFixChapters(projectId);
      }

      // STEP 2: Process Images (40-50%)
      const imageCount = await this.dataSource
        .createQueryBuilder()
        .select('COUNT(*)', 'count')
        .from('images', 'i')
        .where('i.projectId = :projectId', { projectId })
        .getRawOne();

      if (
        imageCount.count === '0' &&
        files?.images &&
        files.images.length > 0
      ) {
        await this.updateJobProgress(job, 40, 'Processing images');
        this.logger.log(
          `[${projectId}] Processing ${files.images.length} images...`,
        );

        await this.processImages(projectId, createBookDto, files.images);

        if (files.mapImage && files.mapImage.length > 0) {
          const mapFile = this.bufferToMulterFile(files.mapImage[0]);
          await this.imageService.uploadImage(projectId, mapFile, {
            isMap: true,
            caption: createBookDto.mapCaption,
          });
        }

        await this.updateJobProgress(job, 50, 'Images processed');
        this.extremeCleanup();
        this.logMemory('After Image Processing');
      } else {
        this.logger.log(`[${projectId}] Images already uploaded`);
        await this.updateJobProgress(job, 50, 'Images already exist');
      }

      // STEP 3: Translate (50-70%)
      await this.updateProjectStatus(projectId, ProjectStatus.TRANSLATING);
      await this.updateJobProgress(job, 50, 'Starting translations');

      const targetLanguages = [
        Language.GERMAN,
        Language.FRENCH,
        Language.SPANISH,
        Language.ITALIAN,
      ];

      await this.translateSequentially(projectId, targetLanguages, job);
      await this.updateJobProgress(job, 70, 'Translations completed');
      this.extremeCleanup();
      this.logMemory('After Translations');

      // STEP 4: PRE-CACHE IMAGES
      this.logger.log(
        `[${projectId}] Pre-caching images for document generation...`,
      );
      await this.preCacheImages(projectId);
      this.logMemory('After Image Caching');

      // STEP 5: Generate Documents (70-100%)
      await this.updateProjectStatus(
        projectId,
        ProjectStatus.GENERATING_DOCUMENTS,
      );
      await this.updateJobProgress(job, 70, 'Generating documents');

      await this.generateDocumentsSequentially(projectId, job);
      await this.updateJobProgress(job, 100, 'All documents generated');

      // Clear image cache
      this.clearImageCache();
      this.logMemory('After Documents');

      // Complete
      await this.updateProjectStatus(projectId, ProjectStatus.COMPLETED);
      this.logger.log(`[${projectId}] ✅ Book generation completed!`);

      this.extremeCleanup();
      this.logMemory('Job Complete');

      await this.delay(2000);

      return {
        success: true,
        projectId,
        message: 'Book generation completed successfully',
      };
    } catch (error) {
      this.logger.error(`[${projectId}] Book generation failed:`, error);
      this.logMemory('Job Failed');

      try {
        await this.updateProjectStatus(projectId, ProjectStatus.FAILED);
      } catch (updateError) {
        this.logger.error(`Failed to update project status:`, updateError);
      }

      throw error;
    } finally {
      this.clearImageCache();
      this.extremeCleanup();
      this.logMemory('Job Cleanup');
    }
  }

  /**
   * PRE-CACHE ALL IMAGES with retry logic
   */
  private async preCacheImages(projectId: string): Promise<void> {
    const images = await this.dataSource
      .createQueryBuilder()
      .select(['i.id', 'i.url'])
      .from('images', 'i')
      .where('i.projectId = :projectId', { projectId })
      .getRawMany();

    this.logger.log(`Pre-caching ${images.length} images...`);

    for (const image of images) {
      if (!this.imageCache.has(image.i_url)) {
        await this.cacheImageWithRetry(image.i_url);
      }
    }

    this.logger.log(
      `✅ Image cache ready: ${this.imageCache.size}/${images.length} images`,
    );
  }

  private async cacheImageWithRetry(
    url: string,
    maxRetries = 4,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.log(
          `[Attempt ${attempt}/${maxRetries}] Caching: ${url.substring(url.lastIndexOf('/') + 1)}`,
        );

        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 60000,
          maxContentLength: 10 * 1024 * 1024,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TravelGuideBot/1.0)',
          },
          family: 4,
        });

        const buffer = Buffer.from(response.data);
        this.imageCache.set(url, buffer);

        this.logger.log(
          `✓ Cached successfully: ${url.substring(url.lastIndexOf('/') + 1)} (${Math.round(buffer.length / 1024)}KB)`,
        );
        return;
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;

        this.logger.warn(
          `[Attempt ${attempt}/${maxRetries}] Failed to cache ${url}:`,
          error.message,
        );

        if (!isLastAttempt) {
          const delayMs = Math.pow(2, attempt) * 1000;
          await this.delay(delayMs);
        } else {
          this.logger.error(
            `❌ Failed to cache image after ${maxRetries} attempts:`,
            { url, error: error.message },
          );
        }
      }
    }
  }

  getCachedImage(url: string): Buffer | null {
    return this.imageCache.get(url) || null;
  }

  private clearImageCache(): void {
    const size = this.imageCache.size;
    const totalBytes = Array.from(this.imageCache.values()).reduce(
      (sum, buffer) => sum + buffer.length,
      0,
    );

    this.imageCache.clear();

    this.logger.log(
      `🧹 Image cache cleared: ${size} images, ${Math.round(totalBytes / 1024 / 1024)}MB freed`,
    );
  }

  /**
   * CRITICAL FIX: EXTREME cleanup with long pauses for GC
   */
  private async extremeCleanup(): Promise<void> {
    if (global.gc) {
      for (let i = 0; i < 10; i++) {
        global.gc();
        await this.delay(200); // Wait between GC calls
      }
      this.logger.debug('Extreme garbage collection completed (10 passes)');
    }
  }

  private async validateAndFixChapters(projectId: string): Promise<void> {
    const result = await this.chapterRepository
      .createQueryBuilder()
      .update(Chapter)
      .set({ projectId: projectId })
      .where('projectId IS NULL')
      .andWhere('project = :projectId', { projectId })
      .execute();

    if (result.affected && result.affected > 0) {
      this.logger.log(`Fixed ${result.affected} chapters with null projectId`);
    }
  }

  private async updateProjectStatus(
    projectId: string,
    status: ProjectStatus,
  ): Promise<void> {
    await this.projectRepository
      .createQueryBuilder()
      .update(Project)
      .set({ status })
      .where('id = :id', { id: projectId })
      .execute();
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

        await this.extremeCleanup();
        await this.delay(5000);
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

  /**
   * CRITICAL FIX: Generate documents with MASSIVE delays and cleanup
   */
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

    const existingDocs = await this.dataSource
      .createQueryBuilder()
      .select("CONCAT(d.type, '-', d.language)", 'key')
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
            `Skipping ${type} (${language}) - exists`,
          );
          continue;
        }

        completed++;
        const percent = 70 + Math.floor((completed / totalDocs) * 30);
        await this.updateJobProgress(
          job,
          percent,
          `Generating ${type} (${language}) ${completed}/${totalDocs}`,
        );

        this.logMemory(`Before ${type}-${language}`);

        await this.documentService.generateDocumentSync(
          projectId,
          {
            type,
            language,
            includeImages: true,
          },
          this.imageCache,
        );

        this.logMemory(`After ${type}-${language}`);

        // CRITICAL: MASSIVE cleanup + long delay
        this.logger.log(
          `💤 Starting extreme cleanup for ${type}-${language}...`,
        );

        // Clear ALL possible references
        if (global.gc) {
          for (let i = 0; i < 15; i++) {
            global.gc();
            await this.delay(300);
          }
        }

        // MASSIVE delay for memory recovery (30 seconds)
        this.logger.log(`💤 Waiting 30 seconds for memory recovery...`);
        await this.delay(30000);

        this.logMemory(`After cleanup ${type}-${language}`);
      }
    }
  }

  private async processImages(
    projectId: string,
    createBookDto: any,
    images: any[],
  ) {
    const totalImages = images.length;
    let chapterNumbers = createBookDto.imageChapterNumbers;

    if (!chapterNumbers || chapterNumbers.length !== totalImages) {
      const mainChapters = Array.from({ length: 8 }, (_, i) => i + 2);
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
    }
  }

  private bufferToMulterFile(fileData: any): Express.Multer.File {
    let buffer: Buffer;

    if (
      fileData.buffer?.type === 'Buffer' &&
      Array.isArray(fileData.buffer.data)
    ) {
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
      const maxWaitTime = 600000;
      const checkInterval = 5000;
      let elapsedTime = 0;

      const interval = setInterval(async () => {
        try {
          elapsedTime += checkInterval;

          if (elapsedTime >= maxWaitTime) {
            clearInterval(interval);
            reject(new Error(`Job ${jobId} timed out`));
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

  private logMemory(label: string): void {
    const used = process.memoryUsage();
    this.logger.log(
      `[Memory ${label}] Heap: ${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB | RSS: ${Math.round(used.rss / 1024 / 1024)}MB`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`Job ${job.id} completed successfully`);
    this.clearImageCache();
    this.extremeCleanup();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed:`, error);
    this.clearImageCache();
    this.extremeCleanup();
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.log(`Job ${job.id} is now active`);
  }
}
