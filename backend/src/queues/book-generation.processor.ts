// src/queues/book-generation.processor.ts - COMPLETE FIXED VERSION
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
import { RedisCacheService } from './cache/redis-cache.service';

@Processor('book-generation', {
  concurrency: 1,
  limiter: {
    max: 1,
    duration: 1000,
  },
})
export class BookGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(BookGenerationProcessor.name);
  private readonly MAX_HEAP_MB = 2000;
  private readonly CRITICAL_HEAP_MB = 3000;

  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Chapter)
    private readonly chapterRepository: Repository<Chapter>,
    private readonly contentService: ContentService,
    private readonly translationService: TranslationService,
    private readonly documentService: DocumentService,
    private readonly imageService: ImageService,
    private readonly redisCache: RedisCacheService,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job<BookGenerationJobData>): Promise<any> {
    const { projectId, createBookDto, files } = job.data;

    this.logMemory('Job Start');

    try {
      this.logger.log(`[${projectId}] Starting book generation job ${job.id}`);

      // Wait for project to be available in database
      await this.waitForProjectAvailability(projectId);

      // STEP 1: Generate Content
      await this.generateContent(job, projectId, createBookDto);
      await this.aggressiveCleanup('After Content');

      // STEP 2: Process Images
      await this.processImagesStep(job, projectId, createBookDto, files);
      await this.aggressiveCleanup('After Images');

      // STEP 3: Translate
      await this.translateStep(job, projectId);
      await this.aggressiveCleanup('After Translations');

      // STEP 4: Pre-cache images to Redis
      this.logger.log(`[${projectId}] Pre-caching images to Redis...`);
      await this.preCacheImagesToRedis(projectId);
      await this.aggressiveCleanup('After Image Caching');

      // STEP 5: Generate Documents
      await this.generateDocumentsWithMemoryManagement(projectId, job);

      // Final cleanup
      await this.redisCache.clearProject(projectId);
      await this.updateProjectStatus(projectId, ProjectStatus.COMPLETED);

      this.logger.log(`[${projectId}] ✅ Book generation completed!`);
      await this.aggressiveCleanup('Job Complete');

      return {
        success: true,
        projectId,
        message: 'Book generation completed successfully',
      };
    } catch (error) {
      this.logger.error(`[${projectId}] Book generation failed:`, error);

      try {
        await this.updateProjectStatus(projectId, ProjectStatus.FAILED);
        await this.redisCache.clearProject(projectId);
      } catch (updateError) {
        this.logger.error(`Failed to update project status:`, updateError);
      }

      throw error;
    } finally {
      await this.redisCache.clearAllImages();
      await this.aggressiveCleanup('Job Cleanup');
    }
  }

  /**
   * Wait for project to be committed to database
   */
  private async waitForProjectAvailability(
    projectId: string,
    maxAttempts = 10,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const project = await this.projectRepository.findOne({
          where: { id: projectId },
        });

        if (project) {
          this.logger.log(`[${projectId}] Project found in database`);
          return;
        }

        if (attempt < maxAttempts) {
          const delayMs = attempt * 1000;
          this.logger.warn(
            `[${projectId}] Project not found (attempt ${attempt}/${maxAttempts}), waiting ${delayMs}ms...`,
          );
          await this.delay(delayMs);
        }
      } catch (error) {
        this.logger.error(`Error checking project availability:`, error);
        if (attempt === maxAttempts) {
          throw error;
        }
        await this.delay(attempt * 1000);
      }
    }

    throw new Error(
      `Project ${projectId} not found after ${maxAttempts} attempts`,
    );
  }

  /**
   * Pre-cache images to Redis using native HTTPS
   */
  private async preCacheImagesToRedis(projectId: string): Promise<void> {
    const images = await this.dataSource
      .createQueryBuilder()
      .select(['i.id', 'i.url'])
      .from('images', 'i')
      .where('i.projectId = :projectId', { projectId })
      .getRawMany();

    this.logger.log(`📦 Pre-caching ${images.length} images to Redis...`);

    let cached = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const num = i + 1;
      const filename = this.getFilename(image.i_url);

      try {
        const exists = await this.redisCache.hasImage(image.i_url);

        if (exists) {
          this.logger.log(
            `[${num}/${images.length}] ✓ Already cached: ${filename}`,
          );
          skipped++;
          continue;
        }

        this.logger.log(`[${num}/${images.length}] Caching: ${filename}`);
        await this.cacheImageToRedis(image.i_url);
        cached++;

        // Delay between images
        await this.delay(2000);
      } catch (error) {
        failed++;
        this.logger.warn(
          `[${num}/${images.length}] ⚠️  Skipping: ${filename} (will download during PDF generation)`,
        );
      }

      // GC every 3 images
      if (num % 3 === 0 && global.gc) {
        global.gc();
        await this.delay(500);
      }
    }

    const stats = await this.redisCache.getMemoryStats();

    this.logger.log(
      `✅ Image caching complete: ${cached} cached, ${skipped} skipped, ${failed} failed - Redis: ${stats.used}`,
    );

    if (failed > images.length / 2) {
      this.logger.warn(
        `⚠️  ${failed}/${images.length} images failed - documents will be slower`,
      );
    }
  }

  /**
   * Cache single image to Redis using native Node.js HTTPS
   */
  private async cacheImageToRedis(url: string, maxRetries = 3): Promise<void> {
    const filename = this.getFilename(url);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const buffer = await this.downloadImageNative(url);
        const sizeKB = Math.round(buffer.length / 1024);

        await this.redisCache.cacheImage(url, buffer, 7200);

        this.logger.log(`✓ Cached: ${filename} (${sizeKB}KB)`);
        return;
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const errorMsg = error.message || 'Unknown error';
        const errorCode = error.code || 'NO_CODE';

        if (!isLastAttempt) {
          const delayMs = 3000 * attempt;
          this.logger.warn(
            `[${filename}] Retry ${attempt}/${maxRetries} failed (${errorCode}). Waiting ${delayMs}ms...`,
          );
          await this.delay(delayMs);
        } else {
          this.logger.error(
            `[${filename}] Failed after ${maxRetries} attempts (${errorCode}): ${errorMsg}`,
          );
        }
      }
    }
  }

  /**
   * Download image using native Node.js HTTPS (no axios, no connection pooling)
   */
  private downloadImageNative(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const timeout = 60000;

      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TravelGuideBot/1.0)',
          Accept: 'image/*',
        },
        timeout: timeout,
      };

      const req = https.get(url, options, (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          return resolve(this.downloadImageNative(res.headers.location));
        }

        if (res.statusCode !== 200) {
          return reject(
            new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`),
          );
        }

        const chunks: Buffer[] = [];
        let totalLength = 0;

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          totalLength += chunk.length;

          // Safety: 10MB limit
          if (totalLength > 10 * 1024 * 1024) {
            req.destroy();
            reject(new Error('Image too large (>10MB)'));
          }
        });

        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve(buffer);
        });

        res.on('error', (err) => {
          reject(err);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout after ${timeout}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.setTimeout(timeout);
    });
  }

  private getFilename(url: string): string {
    return url.substring(url.lastIndexOf('/') + 1);
  }

  /**
   * Generate documents with memory management
   */
  private async generateDocumentsWithMemoryManagement(
    projectId: string,
    job: Job,
  ): Promise<void> {
    await this.updateProjectStatus(
      projectId,
      ProjectStatus.GENERATING_DOCUMENTS,
    );

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
      this.logger.log(`\n🌐 Processing ${language} documents...`);

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

        // Memory check
        const heapMB = this.getHeapUsedMB();
        if (heapMB > this.MAX_HEAP_MB) {
          this.logger.warn(
            `⚠️ High memory (${heapMB}MB) before ${type}-${language}`,
          );
          await this.aggressiveCleanup(`Before ${type}-${language}`);
          await this.delay(5000);

          const newHeapMB = this.getHeapUsedMB();
          if (newHeapMB > this.CRITICAL_HEAP_MB) {
            throw new Error(
              `Critical memory (${newHeapMB}MB) - stopping to prevent crash`,
            );
          }
        }

        completed++;
        const percent = 70 + Math.floor((completed / totalDocs) * 30);
        await this.updateJobProgress(
          job,
          percent,
          `Generating ${type} (${language}) [${completed}/${totalDocs}]`,
        );

        this.logMemory(`Before ${type}-${language}`);

        await this.documentService.generateDocumentSync(
          projectId,
          {
            type,
            language,
            includeImages: true,
          },
          this.redisCache,
        );

        this.logger.log(`✓ Generated ${type} (${language})`);
        this.logMemory(`After ${type}-${language}`);

        await this.aggressiveCleanup(`After ${type}-${language}`);
        await this.delay(2000);
      }

      this.logger.log(`✅ Completed all ${language} documents`);
      await this.delay(5000);
      await this.aggressiveCleanup(`After all ${language} docs`);
    }

    this.logger.log('✅ All documents generated successfully');
  }

  /**
   * Aggressive garbage collection
   */
  private async aggressiveCleanup(label: string): Promise<void> {
    if (global.gc) {
      for (let i = 0; i < 10; i++) {
        global.gc();
        await this.delay(100);
      }
    }

    await this.delay(2000);
    this.logMemory(`Cleanup ${label}`);
  }

  private getHeapUsedMB(): number {
    return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  }

  // ============= Helper Methods =============

  private async generateContent(
    job: Job,
    projectId: string,
    createBookDto: any,
  ) {
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
    } else {
      this.logger.log(
        `[${projectId}] Content exists (${chapterCount} chapters)`,
      );
      await this.updateJobProgress(job, 40, 'Content already exists');
      await this.validateAndFixChapters(projectId);
    }
  }

  private async processImagesStep(
    job: Job,
    projectId: string,
    createBookDto: any,
    files: any,
  ) {
    const imageCount = await this.dataSource
      .createQueryBuilder()
      .select('COUNT(*)', 'count')
      .from('images', 'i')
      .where('i.projectId = :projectId', { projectId })
      .getRawOne();

    if (imageCount.count === '0' && files?.images && files.images.length > 0) {
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
    } else {
      this.logger.log(`[${projectId}] Images already uploaded`);
      await this.updateJobProgress(job, 50, 'Images already exist');
    }
  }

  private async translateStep(job: Job, projectId: string) {
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

        if (global.gc) {
          for (let j = 0; j < 5; j++) {
            global.gc();
            await this.delay(200);
          }
        }

        await this.delay(3000);
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
    const heapMB = Math.round(used.heapUsed / 1024 / 1024);
    const totalMB = Math.round(used.heapTotal / 1024 / 1024);
    const rssMB = Math.round(used.rss / 1024 / 1024);

    this.logger.log(
      `[Memory ${label}] Heap: ${heapMB}MB / ${totalMB}MB | RSS: ${rssMB}MB`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`Job ${job.id} completed successfully`);
    const { projectId } = job.data;
    this.redisCache.clearProject(projectId);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed:`, error);
    const { projectId } = job.data;
    this.redisCache.clearProject(projectId);
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.log(`Job ${job.id} is now active`);
  }
}
