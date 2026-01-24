// src/queues/book-generation.processor.ts - UPDATED WORKFLOW
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BookGenerationJobData } from './book-generation.queue';
import { DocumentGenerationQueue } from './document-generation.queue';
import { DocumentTranslationQueue } from './document-translation.queue'; // NEW
import {
  Project,
  ProjectStatus,
  JobStatus,
  Language,
  Chapter,
  DocumentType,
} from '../DB/entities';
import { ContentService } from '../content/content.service';
import { ImageService } from '../images/image.service';
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
    private readonly imageService: ImageService,
    private readonly redisCache: RedisCacheService,
    private readonly documentQueue: DocumentGenerationQueue,
    private readonly documentTranslationQueue: DocumentTranslationQueue, // NEW
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job<BookGenerationJobData>): Promise<any> {
    const { projectId, createBookDto, files } = job.data;
    this.logMemory('Job Start');

    try {
      this.logger.log(`[${projectId}] Starting book generation job ${job.id}`);

      await this.waitForProjectAvailability(projectId);

      // STEP 1: Content (0-30%)
      await this.generateContent(job, projectId, createBookDto);
      if (global.gc) global.gc();

      // STEP 2: Images (30-40%)
      await this.processImagesStep(job, projectId, createBookDto, files);
      if (global.gc) global.gc();

      // STEP 3: Pre-cache images to Redis (40-50%)
      this.logger.log(`[${projectId}] Pre-caching images to Redis...`);
      await this.preCacheImagesToRedis(projectId);
      if (global.gc) global.gc();

      // STEP 4: Generate ENGLISH documents (PDF + DOCX) (50-65%)
      this.logger.log(`[${projectId}] 🚀 Generating English documents...`);
      await this.generateEnglishDocuments(projectId, job);

      // STEP 5: Translate documents to other languages (65-100%)
      this.logger.log(
        `[${projectId}] 🌍 Translating documents to 4 languages...`,
      );
      await this.translateDocuments(projectId, job);

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
   * NEW: Generate English documents first (PDF + DOCX)
   */
  private async generateEnglishDocuments(
    projectId: string,
    job: Job,
  ): Promise<void> {
    await this.updateProjectStatus(
      projectId,
      ProjectStatus.GENERATING_DOCUMENTS,
    );

    const project = await this.projectRepository.findOne({
      where: { id: projectId },
    });

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const types = [DocumentType.PDF, DocumentType.DOCX];
    const totalDocs = types.length;
    let completed = 0;

    // Check existing English documents
    const existingDocs = await this.dataSource
      .createQueryBuilder()
      .select('d.type', 'type')
      .from('documents', 'd')
      .where('d.projectId = :projectId', { projectId })
      .andWhere('d.language = :language', { language: Language.ENGLISH })
      .getRawMany();

    const existingTypes = new Set(existingDocs.map((doc) => doc.type));

    const jobPromises: Promise<any>[] = [];

    for (const type of types) {
      if (existingTypes.has(type)) {
        completed++;
        const percent = 50 + Math.floor((completed / totalDocs) * 15);
        await this.updateJobProgress(
          job,
          percent,
          `Skipping English ${type} - exists`,
        );
        continue;
      }

      this.logger.log(`📤 Queuing English ${type} to worker...`);

      const docJobId = await this.documentQueue.addDocumentJob({
        projectId,
        type,
        language: Language.ENGLISH,
        title: project.title,
        subtitle: project.subtitle,
        author: project.author,
        includeImages: true,
      });

      jobPromises.push(
        this.waitForDocumentJob(docJobId, type, Language.ENGLISH).then(() => {
          completed++;
          const percent = 50 + Math.floor((completed / totalDocs) * 15);
          return this.updateJobProgress(
            job,
            percent,
            `Generated English ${type} [${completed}/${totalDocs}]`,
          );
        }),
      );
    }

    await Promise.all(jobPromises);

    if (global.gc) global.gc();
    this.logMemory('After English documents');

    this.logger.log('✅ English documents generated');
  }

  /**
   * ✅ FIXED: Translate documents - Queue PDF + DOCX together for each language
   */
  private async translateDocuments(projectId: string, job: Job): Promise<void> {
    const targetLanguages = [
      Language.GERMAN,
      Language.FRENCH,
      Language.SPANISH,
      Language.ITALIAN,
    ];

    const types = [DocumentType.PDF, DocumentType.DOCX];
    const totalDocs = targetLanguages.length * types.length; // 4 * 2 = 8
    let completed = 0;

    // Check existing translated documents
    const existingDocs = await this.dataSource
      .createQueryBuilder()
      .select("CONCAT(d.type, '-', d.language)", 'key')
      .from('documents', 'd')
      .where('d.projectId = :projectId', { projectId })
      .andWhere('d.language != :english', { english: Language.ENGLISH })
      .getRawMany();

    const existingKeys = new Set(existingDocs.map((doc) => doc.key));

    // ✅ PROCESS BY LANGUAGE: Queue both PDF and DOCX for each language together
    for (const language of targetLanguages) {
      const languageJobs: Promise<any>[] = [];

      this.logger.log(`🌍 Starting translation to ${language}...`);

      // Queue both formats for this language
      for (const type of types) {
        const docKey = `${type}-${language}`;

        if (existingKeys.has(docKey)) {
          completed++;
          const percent = 65 + Math.floor((completed / totalDocs) * 35);
          await this.updateJobProgress(
            job,
            percent,
            `Skipping ${type} (${language}) - exists`,
          );
          continue;
        }

        this.logger.log(`📤 Queuing ${type} translation to ${language}...`);

        const transJobId =
          await this.documentTranslationQueue.addTranslationJob({
            projectId,
            type,
            sourceLanguage: Language.ENGLISH,
            targetLanguage: language,
          });

        languageJobs.push(
          this.waitForTranslationJob(transJobId, type, language).then(() => {
            completed++;
            const percent = 65 + Math.floor((completed / totalDocs) * 35);
            return this.updateJobProgress(
              job,
              percent,
              `Translated ${type} to ${language} [${completed}/${totalDocs}]`,
            );
          }),
        );
      }

      // Wait for both PDF and DOCX for this language to complete
      if (languageJobs.length > 0) {
        await Promise.all(languageJobs);
        this.logger.log(`✅ Completed ${language} translation (PDF + DOCX)`);

        // Small delay between languages
        if (language !== Language.ITALIAN) {
          await this.delay(3000);
        }

        if (global.gc) global.gc();
        this.logMemory(`After ${language} translation`);
      }
    }

    this.logger.log('✅ All documents translated');
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

  /**
   * NEW: Wait for translation worker to complete
   */
  private async waitForTranslationJob(
    jobId: string,
    type: DocumentType,
    language: Language,
  ): Promise<void> {
    const maxWaitTime = 900000; // 10 minutes
    const checkInterval = 2000;
    let elapsedTime = 0;

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          elapsedTime += checkInterval;

          if (elapsedTime >= maxWaitTime) {
            clearInterval(interval);
            reject(new Error(`Translation job ${jobId} timed out`));
            return;
          }

          const status =
            await this.documentTranslationQueue.getJobStatus(jobId);

          if (status.status === 'completed') {
            clearInterval(interval);
            this.logger.log(`✅ Translated ${type} to ${language}`);
            resolve();
          } else if (status.status === 'failed') {
            clearInterval(interval);
            this.logger.error(
              `❌ Translation failed ${type} to ${language}: ${status.failedReason}`,
            );
            reject(
              new Error(
                `Translation job ${jobId} failed: ${status.failedReason}`,
              ),
            );
          }
        } catch (error) {
          clearInterval(interval);
          reject(error);
        }
      }, checkInterval);
    });
  }

  // ... (keep all other methods: preCacheImagesToRedis, generateContent,
  //      processImagesStep, waitForProjectAvailability, etc. - unchanged)

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

          // ✅ CHECK: If project is already COMPLETED or FAILED, don't process again
          if (project.status === ProjectStatus.COMPLETED) {
            this.logger.log(
              `[${projectId}] Project already completed. Skipping retry.`,
            );
            throw new Error(`Project ${projectId} already completed`);
          }

          if (project.status === ProjectStatus.FAILED) {
            this.logger.log(
              `[${projectId}] Project already failed. Skipping retry.`,
            );
            throw new Error(`Project ${projectId} already failed`);
          }

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

  private async downloadImageNative(
    url: string,
    maxRetries: number = 4,
    timeoutMs: number = 60000,
  ): Promise<Buffer> {
    let lastError: any;
    const axios = require('axios');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.log(
          `[Attempt ${attempt}/${maxRetries}] Downloading image: ${url}`,
        );

        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: timeoutMs,
          maxContentLength: 10 * 1024 * 1024,
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TravelGuideGenerator/1.0)',
          },
          family: 4,
        });

        this.logger.log(`✓ Image downloaded successfully: ${url}`);
        return Buffer.from(response.data, 'binary');
      } catch (error) {
        lastError = error;

        if (axios.isAxiosError(error)) {
          const code = error.code || error.response?.status;
          this.logger.warn(
            `[Attempt ${attempt}/${maxRetries}] Failed to download image: ${code}`,
          );

          if (
            error.response?.status === 404 ||
            error.response?.status === 403
          ) {
            this.logger.error(`Image not found or forbidden: ${url}`);
            throw new Error(`Image not accessible: ${url}`);
          }
        }

        if (attempt < maxRetries) {
          const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          this.logger.log(`Waiting ${waitTime}ms before retry...`);
          await this.delay(waitTime);
        }
      }
    }

    this.logger.error(
      `Failed to download image after ${maxRetries} attempts: ${url}`,
    );
    throw lastError;
  }

  private async cacheImageToRedis(
    url: string,
    maxRetries: number = 3,
  ): Promise<boolean> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const exists = await this.redisCache.hasImage(url);
        if (exists) {
          this.logger.debug(
            `✓ Already cached: ${url.substring(url.lastIndexOf('/') + 1)}`,
          );
          return true;
        }

        const buffer = await this.downloadImageNative(url);
        await this.redisCache.cacheImage(url, buffer, 7200);

        if (attempt > 1) {
          this.logger.log(
            `✅ Successfully cached ${url.substring(url.lastIndexOf('/') + 1)} on attempt ${attempt}/${maxRetries}`,
          );
        }

        return true;
      } catch (error) {
        lastError = error;

        const errorMsg = error?.message || error?.code || 'Unknown error';
        const filename = url.substring(url.lastIndexOf('/') + 1);

        if (attempt < maxRetries) {
          const delayMs = Math.min(Math.pow(2, attempt) * 2000, 20000);
          this.logger.warn(
            `⚠️  Failed to cache ${filename} (attempt ${attempt}/${maxRetries}): ${errorMsg}. Retrying in ${delayMs / 1000}s...`,
          );
          await this.delay(delayMs);
        } else {
          this.logger.error(
            `❌ Failed to cache ${filename} after ${maxRetries} attempts: ${errorMsg}`,
          );
        }
      }
    }

    return false;
  }

  private async preCacheImagesToRedis(projectId: string): Promise<void> {
    const images = await this.dataSource
      .createQueryBuilder()
      .select(['i.id', 'i.url'])
      .from('images', 'i')
      .where('i.projectId = :projectId', { projectId })
      .getRawMany();

    if (images.length === 0) {
      this.logger.log('No images to cache');
      return;
    }

    this.logger.log(`📦 Pre-caching ${images.length} images to Redis...`);

    const failedImages: string[] = [];
    let cached = 0;

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const filename = image.i_url.substring(image.i_url.lastIndexOf('/') + 1);

      this.logger.log(`[${i + 1}/${images.length}] Caching ${filename}...`);

      const success = await this.cacheImageToRedis(image.i_url);

      if (success) {
        cached++;
      } else {
        failedImages.push(image.i_url);
      }

      if (i < images.length - 1) {
        await this.delay(5000);
      }

      if (global.gc && (i + 1) % 3 === 0) {
        global.gc();
      }
    }

    if (failedImages.length > 0) {
      this.logger.warn(
        `⚠️  ${failedImages.length} images failed. Starting retry rounds...`,
      );

      const maxRetryRounds = 2;
      let retryRound = 1;

      while (failedImages.length > 0 && retryRound <= maxRetryRounds) {
        this.logger.log(
          `🔄 Retry round ${retryRound}/${maxRetryRounds} for ${failedImages.length} images...`,
        );

        await this.delay(15000);

        const stillFailing: string[] = [];

        for (const url of failedImages) {
          const success = await this.cacheImageToRedis(url, 3);

          if (success) {
            cached++;
            this.logger.log(`✅ Recovered on retry round ${retryRound}`);
          } else {
            stillFailing.push(url);
          }

          await this.delay(8000);
        }

        failedImages.length = 0;
        failedImages.push(...stillFailing);
        retryRound++;
      }
    }

    const stats = await this.redisCache.getMemoryStats();
    const failed = images.length - cached;

    this.logger.log(
      `✅ Pre-caching complete: ${cached}/${images.length} cached (${failed} failed) - Redis: ${stats.used}`,
    );

    if (failedImages.length > 0) {
      this.logger.warn(
        `⚠️  Workers will download these ${failedImages.length} images during document generation`,
      );
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
      await this.updateJobProgress(job, 30, 'Content generated');
    } else {
      await this.updateJobProgress(job, 30, 'Content exists');
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
      await this.updateJobProgress(job, 30, 'Processing images');
      await this.processImages(projectId, createBookDto, files.images);

      if (files.mapImage?.length > 0) {
        const mapFile = this.bufferToMulterFile(files.mapImage[0]);
        await this.imageService.uploadImage(projectId, mapFile, {
          isMap: true,
          caption: createBookDto.mapCaption,
        });
      }

      await this.updateJobProgress(job, 40, 'Images processed');
    } else {
      await this.updateJobProgress(job, 40, 'Images exist');
    }
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
