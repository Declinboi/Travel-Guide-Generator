import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContentService } from '../content/content.service';
import { TranslationService } from '../translation/translation.service';
import { CreateBookDto } from './create-book.dto';
import { Project } from 'src/DB/entities/project.entity';
import { Job, JobStatus } from 'src/DB/entities/job.entity';
import { Language } from 'src/DB/entities/translation.entity';
import { DocumentType } from 'src/DB/entities/document.entity';
import { ProjectService } from 'src/project/project.service';
import { DocumentService } from 'src/documents/document.service';
import { ImageService } from 'src/images/image.service';

@Injectable()
export class BookGeneratorService {
  private readonly logger = new Logger(BookGeneratorService.name);

  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    // @InjectRepository(Job)
    // private readonly jobRepository: Repository<Job>,
    private readonly projectService: ProjectService,
    private readonly contentService: ContentService,
    private readonly translationService: TranslationService,
    private readonly documentService: DocumentService,
    private readonly imageService: ImageService,
  ) {}

  async generateCompleteBook(
    createBookDto: CreateBookDto,
    files: { images?: Express.Multer.File[]; mapImage?: Express.Multer.File[] },
  ) {
    this.logger.log(
      `Starting complete book generation: ${createBookDto.title}`,
    );

    // Step 1: Create project
    const project = await this.projectService.create({
      title: createBookDto.title,
      subtitle: createBookDto.subtitle,
      author: createBookDto.author,
      numberOfChapters: 10,
    });

    this.logger.log(`Project created: ${project.id}`);

    // Start background processing
    this.processBookGeneration(project.id, createBookDto, files);

    return {
      message: 'Book generation started! This will take several minutes.',
      projectId: project.id,
      estimatedTime: '10-15 minutes',
      steps: [
        '1. Generating book content (10 chapters)',
        '2. Processing and positioning images',
        '3. Translating to 4 languages (German, French, Spanish, Italian)',
        '4. Creating 10 documents (2 formats × 5 languages)',
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
    try {
      // STEP 1: Generate Content (0-40%)
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

      // Wait for content generation to complete
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

      // STEP 3: Translate to All Languages (50-70%)
      this.logger.log(`[${projectId}] Step 3: Translating to 4 languages...`);

      const translationResult =
        await this.translationService.translateToAllLanguages(projectId, {
          targetLanguages: [
            Language.GERMAN,
            Language.FRENCH,
            Language.SPANISH,
            Language.ITALIAN,
          ],
          maintainStyle: true,
        });

      // Wait for all translations
      for (const job of translationResult.jobs) {
        await this.waitForJobCompletion(job.jobId);
      }
      this.logger.log(`[${projectId}] All translations completed`);

      // STEP 4: Generate All Documents (70-100%)
      this.logger.log(`[${projectId}] Step 4: Generating 10 documents...`);

      const documentResult = await this.documentService.generateAllDocuments(
        projectId,
        {
          types: [DocumentType.PDF, DocumentType.DOCX],
          languages: [
            Language.ENGLISH,
            Language.GERMAN,
            Language.FRENCH,
            Language.SPANISH,
            Language.ITALIAN,
          ],
          includeImages: true,
        },
      );

      // Wait for all documents
      for (const job of documentResult.jobs) {
        await this.waitForJobCompletion(job.jobId);
      }

      this.logger.log(`[${projectId}] ✅ Complete book generation finished!`);
    } catch (error) {
      this.logger.error(`[${projectId}] Book generation failed:`, error);

      // Update project status to failed
      const project = await this.projectRepository.findOne({
        where: { id: projectId },
      });
      if (project) {
        project.status = 'FAILED' as any;
        await this.projectRepository.save(project);
      }
    }
  }

  private async processImages(
    projectId: string,
    createBookDto: CreateBookDto,
    images: Express.Multer.File[],
  ) {
    const totalImages = images.length;
    const numberOfChapters = 10;

    // Auto-distribute images across chapters if not specified
    let chapterNumbers = createBookDto.imageChapterNumbers;

    if (!chapterNumbers || chapterNumbers.length !== totalImages) {
      // Auto-distribute: spread images evenly across main chapters (2-9)
      // Skip chapter 1 (intro) and chapter 10 (conclusion)
      const mainChapters = [2, 3, 4, 5, 6, 7, 8, 9];
      chapterNumbers = [];

      for (let i = 0; i < totalImages; i++) {
        const chapterIndex = Math.floor(
          (i / totalImages) * mainChapters.length,
        );
        chapterNumbers.push(mainChapters[chapterIndex]);
      }
    }

    // Upload images with auto-positioning
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
      }, 5000); // Check every 5 seconds
    });
  }

  async getBookStatus(projectId: string) {
    const project = await this.projectService.findOne(projectId);
    const stats = await this.projectService.getProjectStats(projectId);

    // Get all job statuses
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
    if (stats.stats.completedTranslations === 4) overallProgress += 20;
    if (stats.stats.completedDocuments === 10) overallProgress += 30;

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
    const minutesPerPercent = 0.15; // Roughly 15 minutes for 100%
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

    const downloadLinks = documents.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      type: doc.type,
      language: doc.language,
      size: this.formatFileSize(doc.size),
      url: `${process.env.FRONTEND_URL || 'http://localhost:4000'}${doc.url}`,
      downloadUrl: `/api/books/download/${projectId}/${doc.id}`,
    }));

    return {
      projectId,
      title: documents[0]?.project?.title,
      totalDocuments: documents.length,
      documents: downloadLinks,
      zipDownloadUrl: `/api/books/download/${projectId}/all`,
    };
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
}
