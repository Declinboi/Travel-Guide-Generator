// src/queues/book-generation.processor.ts - UPDATED TO USE WORKERS
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BookGenerationJobData } from './book-generation.queue';
import { DocumentGenerationQueue } from './document-generation.queue';
import {
  Project,
  ProjectStatus,
  JobStatus,
  Language,
  Chapter,
} from '../DB/entities';
import { ContentService } from '../content/content.service';
import { TranslationService } from '../translation/translation.service';
import { ImageService } from '../images/image.service';
import { DocumentType } from '../DB/entities/document.entity';
import { RedisCacheService } from './cache/redis-cache.service';

@Processor('book-generation', {
  concurrency: 1,
  limiter: { max: 1, duration: 1000 },
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
    private readonly imageService: ImageService,
    private readonly redisCache: RedisCacheService,
    private readonly documentQueue: DocumentGenerationQueue, // NEW
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job<BookGenerationJobData>): Promise<any> {
    const { projectId, createBookDto, files } = job.data;
    this.logMemory('Job Start');

    try {
      this.logger.log(`[${projectId}] Starting book generation job ${job.id}`);

      // Wait for project
      await this.waitForProjectAvailability(projectId);

      // STEP 1: Content
      await this.generateContent(job, projectId, createBookDto);
      if (global.gc) global.gc();

      // STEP 2: Images
      await this.processImagesStep(job, projectId, createBookDto, files);
      if (global.gc) global.gc();

      // STEP 3: Translations
      await this.translateStep(job, projectId);
      if (global.gc) global.gc();

      // STEP 4: Pre-cache images to Redis
      this.logger.log(`[${projectId}] Pre-caching images to Redis...`);
      await this.preCacheImagesToRedis(projectId);
      if (global.gc) global.gc();

      // STEP 5: Generate documents using WORKER PROCESSES
      this.logger.log(
        `[${projectId}] 🚀 Delegating documents to worker processes...`,
      );
      await this.generateDocumentsUsingWorkers(projectId, job);

      // Cleanup
      await this.redisCache.clearProject(projectId);
      await this.updateProjectStatus(projectId, ProjectStatus.COMPLETED);

      this.logger.log(`[${projectId}] ✅ Book generation completed!`);
      if (global.gc) global.gc();

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
      if (global.gc) global.gc();
      this.logMemory('Job Cleanup');
    }
  }

  /**
   * CRITICAL: Generate documents using separate worker processes
   * This prevents memory accumulation in the main process
   */
  private async generateDocumentsUsingWorkers(
    projectId: string,
    job: Job,
  ): Promise<void> {
    await this.updateProjectStatus(
      projectId,
      ProjectStatus.GENERATING_DOCUMENTS,
    );

    // Get project info
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
    });

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

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

    // Check existing documents
    const existingDocs = await this.dataSource
      .createQueryBuilder()
      .select("CONCAT(d.type, '-', d.language)", 'key')
      .from('documents', 'd')
      .where('d.projectId = :projectId', { projectId })
      .getRawMany();

    const existingKeys = new Set(existingDocs.map((doc) => doc.key));

    // Queue all documents to worker processes
    const jobPromises: Promise<any>[] = [];

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

        // Get translation for title/subtitle
        let title = project.title;
        let subtitle = project.subtitle;

        if (language !== Language.ENGLISH) {
          const translation = await this.dataSource
            .createQueryBuilder()
            .select(['t.title', 't.subtitle'])
            .from('translations', 't')
            .where('t.projectId = :projectId', { projectId })
            .andWhere('t.language = :language', { language })
            .getRawOne();

          if (translation) {
            title = translation.t_title;
            subtitle = translation.t_subtitle;
          }
        }

        // Add job to document worker queue
        this.logger.log(`📤 Queuing ${type} (${language}) to worker...`);

        const docJobId = await this.documentQueue.addDocumentJob({
          projectId,
          type,
          language,
          title,
          subtitle,
          author: project.author,
          includeImages: true,
        });

        // Wait for worker to complete
        jobPromises.push(
          this.waitForDocumentJob(docJobId, type, language).then(() => {
            completed++;
            const percent = 70 + Math.floor((completed / totalDocs) * 30);
            return this.updateJobProgress(
              job,
              percent,
              `Generated ${type} (${language}) [${completed}/${totalDocs}]`,
            );
          }),
        );

        // Process in small batches to avoid overwhelming the queue
        if (jobPromises.length >= 2) {
          await Promise.all(jobPromises);
          jobPromises.length = 0;

          // Small delay between batches
          await this.delay(3000);

          if (global.gc) global.gc();
          this.logMemory(`After ${completed}/${totalDocs} documents`);
        }
      }
    }

    // Wait for remaining jobs
    if (jobPromises.length > 0) {
      await Promise.all(jobPromises);
    }

    this.logger.log('✅ All documents generated by workers');
  }

  /**
   * Wait for document worker to complete
   */
  private async waitForDocumentJob(
    jobId: string,
    type: DocumentType,
    language: Language,
  ): Promise<void> {
    const maxWaitTime = 600000; // 10 minutes
    const checkInterval = 2000;
    let elapsedTime = 0;

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          elapsedTime += checkInterval;

          if (elapsedTime >= maxWaitTime) {
            clearInterval(interval);
            reject(new Error(`Document job ${jobId} timed out`));
            return;
          }

          const status = await this.documentQueue.getJobStatus(jobId);

          if (status.status === 'completed') {
            clearInterval(interval);
            this.logger.log(`✅ Worker completed ${type} (${language})`);
            resolve();
          } else if (status.status === 'failed') {
            clearInterval(interval);
            this.logger.error(
              `❌ Worker failed ${type} (${language}): ${status.failedReason}`,
            );
            reject(
              new Error(`Document job ${jobId} failed: ${status.failedReason}`),
            );
          }
        } catch (error) {
          clearInterval(interval);
          reject(error);
        }
      }, checkInterval);
    });
  }

  // ... (rest of the methods remain the same: preCacheImagesToRedis, generateContent, etc.)
  // Copy from the previous processor implementation

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
        if (attempt === maxAttempts) throw error;
        await this.delay(attempt * 1000);
      }
    }

    throw new Error(
      `Project ${projectId} not found after ${maxAttempts} attempts`,
    );
  }

  private async cacheImageToRedis(url: string): Promise<void> {
    try {
      const buffer = await this.downloadImageNative(url);
      await this.redisCache.cacheImage(url, buffer, 7200);
    } catch (error) {
      // FIX: Handle errors without .message property
      const errorMsg = error?.message || error?.toString() || 'Unknown error';
      this.logger.warn(`Failed to cache ${url}: ${errorMsg}`);
    }
  }

  private downloadImageNative(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const http = require('http'); // Add HTTP support

      // Choose protocol based on URL
      const protocol = url.startsWith('https') ? https : http;

      const req = protocol.get(
        url,
        {
          timeout: 120000, // Increase timeout to 2 minutes
          headers: {
            'User-Agent': 'Mozilla/5.0', // Some servers require this
          },
        },
        (res) => {
          // Handle redirects
          if (res.statusCode === 301 || res.statusCode === 302) {
            this.logger.debug(`Following redirect for ${url}`);
            return this.downloadImageNative(res.headers.location!)
              .then(resolve)
              .catch(reject);
          }

          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }

          const chunks: Buffer[] = [];
          let totalLength = 0;

          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            totalLength += chunk.length;

            // Prevent memory overflow (max 50MB per image)
            if (totalLength > 50 * 1024 * 1024) {
              req.destroy();
              reject(new Error('Image too large (>50MB)'));
            }
          });

          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            this.logger.debug(
              `Downloaded ${url}: ${Math.round(buffer.length / 1024)}KB`,
            );
            resolve(buffer);
          });

          res.on('error', (err) => {
            reject(new Error(`Download error: ${err.message}`));
          });
        },
      );

      req.on('error', (err) => {
        reject(new Error(`Request error: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Download timeout after 120s'));
      });
    });
  }

  private async preCacheImagesToRedis(projectId: string): Promise<void> {
    const images = await this.dataSource
      .createQueryBuilder()
      .select(['i.id', 'i.url'])
      .from('images', 'i')
      .where('i.projectId = :projectId', { projectId })
      .getRawMany();

    this.logger.log(`📦 Pre-caching ${images.length} images to Redis...`);

    // FIX: Process images sequentially with better error handling
    let cached = 0;
    let failed = 0;

    for (const image of images) {
      const exists = await this.redisCache.hasImage(image.i_url);

      if (!exists) {
        try {
          await this.cacheImageToRedis(image.i_url);
          cached++;

          // Small delay to prevent overwhelming Cloudinary
          await this.delay(500);
        } catch (error) {
          failed++;
          this.logger.error(`Failed to cache ${image.i_url}:`, error);
        }
      }
    }

    const stats = await this.redisCache.getMemoryStats();
    this.logger.log(
      `✅ Images cached: ${cached} success, ${failed} failed - Redis: ${stats.used}`,
    );

    // Don't fail the entire process if some images fail
    if (cached === 0 && images.length > 0) {
      this.logger.warn('⚠️  No images were cached, but continuing...');
    }
  }

  private async generateContent(
    job: Job,
    projectId: string,
    createBookDto: any,
  ) {
    await this.updateJobProgress(job, 0, 'Checking content');
    const count = await this.chapterRepository.count({ where: { projectId } });

    if (count === 0) {
      await this.updateJobProgress(job, 5, 'Generating content');
      await this.updateProjectStatus(
        projectId,
        ProjectStatus.GENERATING_CONTENT,
      );

      const result = await this.contentService.generateTravelGuideBook(
        projectId,
        {
          title: createBookDto.title,
          subtitle: createBookDto.subtitle,
          author: createBookDto.author,
          numberOfChapters: 10,
        },
      );

      await this.waitForJobCompletion(result.jobId);
      await this.updateJobProgress(job, 40, 'Content generated');
    } else {
      await this.updateJobProgress(job, 40, 'Content exists');
    }
  }

  private async processImagesStep(
    job: Job,
    projectId: string,
    createBookDto: any,
    files: any,
  ) {
    const count = await this.dataSource
      .createQueryBuilder()
      .select('COUNT(*)', 'count')
      .from('images', 'i')
      .where('i.projectId = :projectId', { projectId })
      .getRawOne();

    if (count.count === '0' && files?.images?.length > 0) {
      await this.updateJobProgress(job, 40, 'Processing images');
      await this.processImages(projectId, createBookDto, files.images);

      if (files.mapImage?.length > 0) {
        const mapFile = this.bufferToMulterFile(files.mapImage[0]);
        await this.imageService.uploadImage(projectId, mapFile, {
          isMap: true,
          caption: createBookDto.mapCaption,
        });
      }

      await this.updateJobProgress(job, 50, 'Images processed');
    } else {
      await this.updateJobProgress(job, 50, 'Images exist');
    }
  }

  private async translateStep(job: Job, projectId: string) {
    await this.updateProjectStatus(projectId, ProjectStatus.TRANSLATING);
    await this.updateJobProgress(job, 50, 'Starting translations');

    const languages = [
      Language.GERMAN,
      Language.FRENCH,
      Language.SPANISH,
      Language.ITALIAN,
    ];

    for (let i = 0; i < languages.length; i++) {
      const lang = languages[i];
      const percent = 50 + Math.floor((i / languages.length) * 20);

      try {
        await this.updateJobProgress(job, percent, `Translating to ${lang}`);
        const result = await this.translationService.translateProject(
          projectId,
          {
            targetLanguage: lang,
            maintainStyle: true,
          },
        );

        await this.waitForJobCompletion(result.jobId);
        if (global.gc) global.gc();
        await this.delay(2000);
      } catch (error) {
        if (!error.message?.includes('already exists')) throw error;
      }
    }

    await this.updateJobProgress(job, 70, 'Translations completed');
  }

  private async processImages(
    projectId: string,
    createBookDto: any,
    images: any[],
  ) {
    const chapterNumbers = createBookDto.imageChapterNumbers || [];

    for (let i = 0; i < images.length; i++) {
      const file = this.bufferToMulterFile(images[i]);
      await this.imageService.uploadImage(projectId, file, {
        chapterNumber: chapterNumbers[i] || (i % 8) + 2,
        caption: createBookDto.imageCaptions?.[i] || `Image ${i + 1}`,
        isMap: false,
      });
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
      buffer,
      originalname: fileData.originalname,
      mimetype: fileData.mimetype,
      fieldname: 'file',
      encoding: '7bit',
      size: buffer.length,
    } as Express.Multer.File;
  }

  private async waitForJobCompletion(jobId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
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
      }, 5000);
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

  private logMemory(label: string): void {
    const used = process.memoryUsage();
    this.logger.log(
      `[Memory ${label}] Heap: ${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB | RSS: ${Math.round(used.rss / 1024 / 1024)}MB`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`Job ${job.id} completed`);
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
    this.logger.log(`Job ${job.id} active`);
  }
}
