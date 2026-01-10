import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Project, ProjectStatus } from 'src/DB/entities/project.entity';
import { Job, JobType, JobStatus } from 'src/DB/entities/job.entity';
import { GeminiService } from './gemini.service';
import { GenerateTravelGuideDto } from './dto/generate-travel-guide.dto';
import { Chapter } from 'src/DB/entities/chapter.entity';

@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    @InjectRepository(Chapter)
    private readonly chapterRepository: Repository<Chapter>,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Job)
    private readonly jobRepository: Repository<Job>,
    private readonly geminiService: GeminiService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async generateTravelGuideBook(
    projectId: string,
    generateDto: GenerateTravelGuideDto,
  ) {
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    // Create job for tracking
    const job = this.jobRepository.create({
      projectId,
      type: JobType.CONTENT_GENERATION,
      status: JobStatus.PENDING,
      progress: 0,
      data: generateDto,
    });
    await this.jobRepository.save(job);

    // Update project
    project.status = ProjectStatus.GENERATING_CONTENT;
    project.numberOfChapters = generateDto.numberOfChapters || 10;
    await this.projectRepository.save(project);

    // Start generation in background
    this.generateTravelGuideBackground(projectId, generateDto, job.id);

    return {
      message: 'Travel guide book generation started',
      jobId: job.id,
      projectId,
      steps: [
        'Step 1: Generating detailed book outline',
        'Step 2: Writing introduction',
        'Step 3: Writing main chapters',
        'Step 4: Writing conclusion',
        'Step 5: Generating front matter and table of contents',
      ],
    };
  }

  private async generateTravelGuideBackground(
    projectId: string,
    generateDto: GenerateTravelGuideDto,
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

      const year = new Date().getFullYear();

      // STEP 1: Generate detailed outline (5% progress)
      this.logger.log(
        `Step 1: Generating book outline for ${generateDto.title}...`,
      );
      job.progress = 5;
      await this.jobRepository.save(job);

      const outline = await this.geminiService.generateBookOutline(
        generateDto.title,
        generateDto.subtitle || '',
        generateDto.numberOfChapters || 10,
      );

      outline.author = generateDto.author;

      job.progress = 10;
      job.result = { outline };
      await this.jobRepository.save(job);

      // STEP 2: Generate front matter (15% progress)
      this.logger.log('Step 2: Generating front matter...');

      const titlePage = await this.geminiService.generateFrontMatter(
        generateDto.title,
        generateDto.subtitle || '',
        generateDto.author,
      );

      await this.saveChapter(projectId, 'Title Page', 0, titlePage);

      const copyright = await this.geminiService.generateCopyright(
        generateDto.author,
        2026,
      );

      await this.saveChapter(projectId, 'Copyright', 1, copyright);

      const aboutBook = await this.geminiService.generateAboutBook(
        generateDto.title,
      );

      await this.saveChapter(projectId, 'About Book', 2, aboutBook);

      const tableOfContents =
        await this.geminiService.generateTableOfContents(outline);
      await this.saveChapter(
        projectId,
        'Table of Contents',
        3,
        tableOfContents,
      );

      job.progress = 15;
      await this.jobRepository.save(job);

      // STEP 3: Generate Introduction (25% progress)
      this.logger.log('Step 3: Writing introduction...');

      const introduction = await this.geminiService.generateIntroduction(
        generateDto.title,
        generateDto.subtitle || '',
        outline,
      );

      await this.saveChapter(
        projectId,
        outline.chapters[0].chapterTitle,
        4,
        introduction,
      );

      job.progress = 25;
      await this.jobRepository.save(job);

      // STEP 4: Generate main chapters (25% - 85% progress)
      this.logger.log('Step 4: Writing main chapters...');

      const mainChapters = outline.chapters.slice(1, -1);
      const progressPerChapter = 60 / mainChapters.length;

      for (let i = 0; i < mainChapters.length; i++) {
        const chapterOutline = mainChapters[i];
        this.logger.log(
          `Writing Chapter ${chapterOutline.chapterNumber}: ${chapterOutline.chapterTitle}`,
        );

        const content = await this.geminiService.generateChapterContent(
          chapterOutline,
          generateDto.title,
          generateDto.subtitle || '',
        );

        await this.saveChapter(
          projectId,
          chapterOutline.chapterTitle,
          4 + i + 1,
          content,
        );

        job.progress = 25 + Math.round((i + 1) * progressPerChapter);
        await this.jobRepository.save(job);

        this.eventEmitter.emit('content.chapter.generated', {
          projectId,
          chapterNumber: chapterOutline.chapterNumber,
          totalChapters: outline.chapters.length,
        });
      }

      // STEP 5: Generate conclusion (95% progress)
      this.logger.log('Step 5: Writing conclusion...');

      const conclusionChapter = outline.chapters[outline.chapters.length - 1];
      const conclusion = await this.geminiService.generateConclusion(
        generateDto.title,
        generateDto.subtitle || '',
        outline,
      );

      await this.saveChapter(
        projectId,
        conclusionChapter.chapterTitle,
        4 + mainChapters.length + 1,
        conclusion,
      );

      job.progress = 95;
      await this.jobRepository.save(job);

      // Mark job as completed
      job.status = JobStatus.COMPLETED;
      job.progress = 100;
      job.completedAt = new Date();
      job.result = {
        ...job.result,
        totalChapters: outline.chapters.length,
        message: 'Book content generation completed successfully',
      };
      await this.jobRepository.save(job);

      // Update project
      const project = await this.projectRepository.findOne({
        where: { id: projectId },
      });
      if (!project) {
        this.logger.error(
          `Project with ID ${projectId} not found during generation update`,
        );
        return;
      }

      project.status = ProjectStatus.COMPLETED;
      await this.projectRepository.save(project);

      this.eventEmitter.emit('content.generation.completed', { projectId });
      this.logger.log(
        `Travel guide book generation completed for project ${projectId}`,
      );
    } catch (error) {
      this.logger.error(
        `Book generation failed for project ${projectId}:`,
        error,
      );

      job.status = JobStatus.FAILED;
      job.error = error.message;
      job.completedAt = new Date();
      await this.jobRepository.save(job);

      const project = await this.projectRepository.findOne({
        where: { id: projectId },
      });
      if (!project) {
        this.logger.error(
          `Project with ID ${projectId} not found during generation update`,
        );
        return;
      }
      project.status = ProjectStatus.FAILED;
      await this.projectRepository.save(project);

      this.eventEmitter.emit('content.generation.failed', {
        projectId,
        error: error.message,
      });
    }
  }

  private async saveChapter(
    projectId: string,
    title: string,
    order: number,
    content: string,
  ) {
    const chapter = this.chapterRepository.create({
      projectId,
      title,
      order,
      content,
    });
    return await this.chapterRepository.save(chapter);
  }

  async getGenerationStatus(jobId: string) {
    const job = await this.jobRepository.findOne({
      where: { id: jobId },
      relations: ['project'],
    });

    if (!job) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }

    return {
      jobId: job.id,
      projectId: job.projectId,
      status: job.status,
      progress: job.progress,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      result: job.result,
    };
  }
}
