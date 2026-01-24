// src/book-generator/book-generator.service.ts - FIXED
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContentService } from '../content/content.service';
import { CreateBookDto } from './create-book.dto';
import { Project, ProjectStatus } from 'src/DB/entities/project.entity';
import { Job, JobStatus } from 'src/DB/entities/job.entity';
import { Language } from 'src/DB/entities/translation.entity';
import { DocumentType } from 'src/DB/entities/document.entity';
import { ProjectService } from 'src/project/project.service';
import { DocumentService } from 'src/documents/document.service';
import { ImageService } from 'src/images/image.service';
import { RedisCacheService } from 'src/queues/cache/redis-cache.service';

@Injectable()
export class BookGeneratorService {
  private readonly logger = new Logger(BookGeneratorService.name);

  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    private readonly projectService: ProjectService,
    private readonly contentService: ContentService,
    private readonly documentService: DocumentService,
    private readonly imageService: ImageService,
    private readonly redisCache: RedisCacheService,
  ) {}

  async generateCompleteBook(
    createBookDto: CreateBookDto,
    files: { images?: Express.Multer.File[]; mapImage?: Express.Multer.File[] },
    userId: string,
  ) {
    this.logger.log(
      `Starting complete book generation: ${createBookDto.title}`,
    );

    const project = await this.projectService.create({
      title: createBookDto.title,
      subtitle: createBookDto.subtitle,
      author: createBookDto.author,
      numberOfChapters: 10,
      userId: createBookDto.userId,
    });

    this.logger.log(`Project created: ${project.id}`);

    this.processBookGeneration(project.id, createBookDto, files);

    return {
      message: 'Book generation started! This will take several minutes.',
      projectId: project.id,
      estimatedTime: '10-15 minutes',
      steps: [
        '1. Generating book content (10 chapters)',
        '2. Processing and positioning images',
        '3. Generating English documents (PDF + DOCX)',
        '4. Translating documents to 4 languages (8 translated documents)',
      ],
      statusEndpoint: `/api/books/status/${project.id}`,
      downloadEndpoint: `/api/books/download/${project.id}`,
    };
  }

  private async processBookGeneration(
    projectId: string,
    createBookDto: CreateBookDto,
    files: { images?: Express.Multer.File[]; mapImage?: Express.Multer.File[] },
  ) {
    let project: Project | null = null;

    try {
      project = await this.projectRepository.findOne({
        where: { id: projectId },
      });

      if (!project) {
        this.logger.error(`Project ${projectId} not found`);
        return;
      }

      // STEP 1: Generate Content (0-40%)
      project.status = ProjectStatus.GENERATING_CONTENT;
      await this.projectRepository.save(project);
      this.logger.log(`[${projectId}] Status updated to: GENERATING_CONTENT`);

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
      this.logger.log(`[${projectId}] Content generation completed`);

      // STEP 2: Upload and Position Images (40-50%)
      if (files.images && files.images.length > 0) {
        this.logger.log(
          `[${projectId}] Step 2: Processing ${files.images.length} images...`,
        );
        await this.processImages(projectId, createBookDto, files.images);
      }

      if (files.mapImage && files.mapImage.length > 0) {
        this.logger.log(`[${projectId}] Processing map image...`);
        await this.imageService.uploadImage(projectId, files.mapImage[0], {
          isMap: true,
          caption: createBookDto.mapCaption,
        });
      }

      // ❌ REMOVED: Translation step - no longer needed
      // Documents will be translated directly instead of content

      // STEP 3: Generate English Documents (50-65%)
      project.status = ProjectStatus.GENERATING_DOCUMENTS;
      await this.projectRepository.save(project);
      this.logger.log(`[${projectId}] Status updated to: GENERATING_DOCUMENTS`);

      this.logger.log(`[${projectId}] Step 3: Generating English documents...`);

      await this.generateEnglishDocuments(projectId);
      this.forceGarbageCollection();

      // STEP 4: Translate Documents (65-100%)
      this.logger.log(
        `[${projectId}] Step 4: Translating documents to 4 languages...`,
      );

      await this.translateDocuments(projectId);

      // ✅ UPDATE STATUS: COMPLETED
      project.status = ProjectStatus.COMPLETED;
      await this.projectRepository.save(project);
      this.logger.log(`[${projectId}] Status updated to: COMPLETED`);

      this.logger.log(`[${projectId}] ✅ Complete book generation finished!`);
    } catch (error) {
      this.logger.error(`[${projectId}] Book generation failed:`, error);

      if (project) {
        project.status = ProjectStatus.FAILED;
        await this.projectRepository.save(project);
        this.logger.log(`[${projectId}] Status updated to: FAILED`);
      }
    }
  }

  /**
   * Generate English documents (PDF + DOCX)
   */
  private async generateEnglishDocuments(projectId: string): Promise<void> {
    const types = [DocumentType.PDF, DocumentType.DOCX];

    this.logger.log(`[${projectId}] Starting English document generation...`);

    this.logMemoryUsage('Before English documents');

    await this.documentService.generateAllDocumentsSequential(
      projectId,
      {
        types,
        languages: [Language.ENGLISH],
        includeImages: true,
      },
      this.redisCache,
    );

    this.forceGarbageCollection();
    this.logMemoryUsage('After English documents');

    this.logger.log(`[${projectId}] English documents generated successfully`);
  }

  /**
   * Translate documents to other languages
   * NOTE: This now happens in the queue/worker, not here
   */
  private async translateDocuments(projectId: string): Promise<void> {
    const targetLanguages = [
      Language.GERMAN,
      Language.FRENCH,
      Language.SPANISH,
      Language.ITALIAN,
    ];

    const types = [DocumentType.PDF, DocumentType.DOCX];

    this.logger.log(`[${projectId}] Starting document translation...`);

    // This will be handled by the queue processor
    // Just logging here for clarity
    this.logger.log(
      `[${projectId}] Documents will be translated to ${targetLanguages.length} languages (${targetLanguages.length * types.length} total documents)`,
    );
  }

  /**
   * Force garbage collection if available
   */
  private forceGarbageCollection(): void {
    if (global.gc) {
      global.gc();
      this.logger.debug('Forced garbage collection');
    }
  }

  /**
   * Log current memory usage
   */
  private logMemoryUsage(label: string): void {
    const used = process.memoryUsage();
    this.logger.log(
      `[Memory ${label}] Heap: ${Math.round(used.heapUsed / 1024 / 1024)} MB / ${Math.round(used.heapTotal / 1024 / 1024)} MB`,
    );
  }

  /**
   * Helper method to create delays
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async processImages(
    projectId: string,
    createBookDto: CreateBookDto,
    images: Express.Multer.File[],
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

      await this.imageService.uploadImage(projectId, images[i], {
        chapterNumber,
        caption,
        isMap: false,
      });

      this.logger.log(
        `Image ${i + 1}/${totalImages} uploaded to Chapter ${chapterNumber}`,
      );
    }
  }

  private async waitForJobCompletion(jobId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        try {
          const status = await this.contentService.getGenerationStatus(jobId);

          if (status.status === JobStatus.COMPLETED) {
            clearInterval(checkInterval);
            resolve();
          } else if (status.status === JobStatus.FAILED) {
            clearInterval(checkInterval);
            reject(new Error(`Job ${jobId} failed: ${status.error}`));
          }
        } catch (error) {
          clearInterval(checkInterval);
          reject(error);
        }
      }, 5000);
    });
  }

  async getBookStatus(projectId: string) {
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
      relations: ['jobs'],
    });

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const stats = await this.projectService.getProjectStats(projectId);

    const jobs = project.jobs || [];
    const activeJobs = jobs.filter(
      (j) =>
        j.status === JobStatus.IN_PROGRESS || j.status === JobStatus.PENDING,
    );
    const completedJobs = jobs.filter((j) => j.status === JobStatus.COMPLETED);
    const failedJobs = jobs.filter((j) => j.status === JobStatus.FAILED);

    // Calculate overall progress
    let overallProgress = 0;

    if (stats.stats.totalChapters > 0) overallProgress += 40;
    if (stats.stats.totalImages > 0) overallProgress += 10;
    // ❌ REMOVED: Translation progress check - not needed anymore
    if (stats.stats.completedDocuments === 10) overallProgress += 50;

    const isComplete = overallProgress === 100;
    const hasFailed = failedJobs.length > 0;

    return {
      projectId: project.id,
      title: project.title,
      author: project.author,
      status: project.status,
      progress: overallProgress,
      isComplete,
      hasFailed,
      stats: {
        chapters: stats.stats.totalChapters,
        images: stats.stats.totalImages,
        translations: `${stats.stats.completedTranslations}/4`,
        documents: `${stats.stats.completedDocuments}/10`,
        activeJobs: activeJobs.length,
        completedJobs: completedJobs.length,
        failedJobs: failedJobs.length,
      },
      createdAt: project.createdAt,
      estimatedCompletion: this.estimateCompletion(overallProgress),
    };
  }

  private estimateCompletion(progress: number): string {
    const remainingProgress = 100 - progress;
    const minutesPerPercent = 0.15;
    const remainingMinutes = Math.ceil(remainingProgress * minutesPerPercent);

    if (remainingMinutes < 1) return 'Less than 1 minute';
    if (remainingMinutes === 1) return '1 minute';
    return `${remainingMinutes} minutes`;
  }

  async getDownloadLinks(projectId: string) {
    const documents = await this.documentService.findAll(projectId);

    if (documents.length === 0) {
      return {
        message:
          'No documents available yet. Generation may still be in progress.',
        projectId,
      };
    }

    const project = await this.projectRepository.findOne({
      where: { id: projectId },
      select: ['id', 'title'],
    });

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const downloadLinks = documents.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      type: doc.type,
      language: doc.language,
      size: this.formatFileSize(doc.size),
      url: doc.url,
      cloudinaryPublicId: doc.storageKey,
      createdAt: doc.createdAt,
    }));

    return {
      projectId,
      title: project.title,
      totalDocuments: documents.length,
      documents: downloadLinks,
    };
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
}
