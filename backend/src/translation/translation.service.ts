import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GeminiTranslationService } from './gemini-translation.service';
import {
  TranslateProjectDto,
  BulkTranslateDto,
} from './dto/translate-project.dto';
import {
  Translation,
  TranslationStatus,
  Language,
  Job,
  JobType,
  JobStatus,
  Chapter,
  Project,
  ProjectStatus,
} from 'src/DB/entities';

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);

  constructor(
    @InjectRepository(Translation)
    private readonly translationRepository: Repository<Translation>,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Chapter)
    private readonly chapterRepository: Repository<Chapter>,
    @InjectRepository(Job)
    private readonly jobRepository: Repository<Job>,
    private readonly geminiTranslationService: GeminiTranslationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async translateProject(projectId: string, translateDto: TranslateProjectDto) {
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
      relations: ['chapters'],
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    if (!project.chapters || project.chapters.length === 0) {
      throw new BadRequestException('Project has no content to translate');
    }

    if (translateDto.targetLanguage === Language.ENGLISH) {
      throw new BadRequestException(
        'Cannot translate to English - source content is already in English',
      );
    }

    // Check if translation already exists
    const existingTranslation = await this.translationRepository.findOne({
      where: { projectId, language: translateDto.targetLanguage },
    });

    if (
      existingTranslation &&
      existingTranslation.status === TranslationStatus.COMPLETED
    ) {
      throw new BadRequestException(
        `Translation to ${translateDto.targetLanguage} already exists`,
      );
    }

    // Create or update translation record
    let translation = existingTranslation;
    if (!translation) {
      translation = this.translationRepository.create({
        projectId,
        language: translateDto.targetLanguage,
        title: project.title,
        subtitle: project.subtitle,
        content: [],
        status: TranslationStatus.PENDING,
      });
      await this.translationRepository.save(translation);
    } else {
      translation.status = TranslationStatus.PENDING;
      await this.translationRepository.save(translation);
    }

    // Create job
    const job = this.jobRepository.create({
      projectId,
      type: JobType.TRANSLATION,
      status: JobStatus.PENDING,
      progress: 0,
      data: translateDto,
    });
    await this.jobRepository.save(job);

    // Update project status
    project.status = ProjectStatus.TRANSLATING;
    await this.projectRepository.save(project);

    // Start translation in background
    this.translateProjectBackground(
      projectId,
      translation.id,
      translateDto,
      job.id,
    );

    return {
      message: `Translation to ${translateDto.targetLanguage} started`,
      jobId: job.id,
      translationId: translation.id,
      projectId,
      targetLanguage: translateDto.targetLanguage,
    };
  }

  private async translateProjectBackground(
    projectId: string,
    translationId: string,
    translateDto: TranslateProjectDto,
    jobId: string,
  ) {
    const job = await this.jobRepository.findOne({ where: { id: jobId } });
    const translation = await this.translationRepository.findOne({
      where: { id: translationId },
    });

    try {
      job.status = JobStatus.IN_PROGRESS;
      job.startedAt = new Date();
      translation.status = TranslationStatus.IN_PROGRESS;
      await this.jobRepository.save(job);
      await this.translationRepository.save(translation);

      const project = await this.projectRepository.findOne({
        where: { id: projectId },
        relations: ['chapters'],
      });

      // Sort chapters by order
      const chapters = project.chapters.sort((a, b) => a.order - b.order);

      // Translate metadata (10% progress)
      this.logger.log(
        `Translating metadata to ${translateDto.targetLanguage}...`,
      );

      const translatedMetadata =
        await this.geminiTranslationService.translateMetadata(
          project.title,
          project.subtitle,
          translateDto.targetLanguage,
        );

      translation.title = translatedMetadata.title;
      translation.subtitle = translatedMetadata.subtitle;
      await this.translationRepository.save(translation);

      job.progress = 10;
      await this.jobRepository.save(job);

      // Translate chapters (10% - 95% progress)
      this.logger.log(`Translating ${chapters.length} chapters...`);

      const progressPerChapter = 85 / chapters.length;
      const translatedChapters = [];

      for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        this.logger.log(
          `Translating chapter ${i + 1}/${chapters.length}: ${chapter.title}`,
        );

        const translatedTitle =
          await this.geminiTranslationService.translateText(
            chapter.title,
            translateDto.targetLanguage,
            false,
          );

        const translatedContent =
          await this.geminiTranslationService.translateText(
            chapter.content,
            translateDto.targetLanguage,
            translateDto.maintainStyle,
          );

        translatedChapters.push({
          title: translatedTitle,
          content: translatedContent,
          order: chapter.order,
        });

        // Update progress
        job.progress = 10 + Math.round((i + 1) * progressPerChapter);
        await this.jobRepository.save(job);

        this.eventEmitter.emit('translation.chapter.completed', {
          projectId,
          translationId,
          chapterNumber: i + 1,
          totalChapters: chapters.length,
          language: translateDto.targetLanguage,
        });
      }

      // Save translated content
      translation.content = translatedChapters as any;
      translation.status = TranslationStatus.COMPLETED;
      translation.completedAt = new Date();
      await this.translationRepository.save(translation);

      // Complete job
      job.status = JobStatus.COMPLETED;
      job.progress = 100;
      job.completedAt = new Date();
      job.result = {
        translationId: translation.id,
        language: translateDto.targetLanguage,
        chaptersTranslated: translatedChapters.length,
      };
      await this.jobRepository.save(job);

      this.eventEmitter.emit('translation.completed', {
        projectId,
        translationId,
        language: translateDto.targetLanguage,
      });

      this.logger.log(
        `Translation to ${translateDto.targetLanguage} completed`,
      );
    } catch (error) {
      this.logger.error(
        `Translation failed for ${translateDto.targetLanguage}:`,
        error,
      );

      translation.status = TranslationStatus.FAILED;
      await this.translationRepository.save(translation);

      job.status = JobStatus.FAILED;
      job.error = error.message;
      job.completedAt = new Date();
      await this.jobRepository.save(job);

      this.eventEmitter.emit('translation.failed', {
        projectId,
        translationId,
        language: translateDto.targetLanguage,
        error: error.message,
      });
    }
  }

  async translateToAllLanguages(projectId: string, bulkDto: BulkTranslateDto) {
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    // Filter out English from target languages
    const targetLanguages = bulkDto.targetLanguages.filter(
      (lang) => lang !== Language.ENGLISH,
    );

    if (targetLanguages.length === 0) {
      throw new BadRequestException('No valid target languages specified');
    }

    const jobs = [];

    for (const language of targetLanguages) {
      try {
        const result = await this.translateProject(projectId, {
          targetLanguage: language,
          maintainStyle: bulkDto.maintainStyle,
        });
        jobs.push(result);
      } catch (error) {
        // If translation already exists, skip it
        if (error.message.includes('already exists')) {
          this.logger.log(`Skipping ${language} - translation already exists`);
        } else {
          throw error;
        }
      }
    }

    return {
      message: `Started translation to ${jobs.length} languages`,
      jobs,
      targetLanguages,
      total: jobs.length,
    };
  }

  async findAll(projectId: string) {
    return await this.translationRepository.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string) {
    const translation = await this.translationRepository.findOne({
      where: { id },
      relations: ['project'],
    });

    if (!translation) {
      throw new NotFoundException(`Translation with ID ${id} not found`);
    }

    return translation;
  }

  async findByLanguage(projectId: string, language: Language) {
    const translation = await this.translationRepository.findOne({
      where: { projectId, language },
    });

    if (!translation) {
      throw new NotFoundException(
        `Translation for project ${projectId} in ${language} not found`,
      );
    }

    return translation;
  }

  async remove(id: string) {
    const translation = await this.findOne(id);
    await this.translationRepository.remove(translation);
  }

  async getTranslationProgress(projectId: string) {
    const translations = await this.findAll(projectId);

    const progress = {
      total: 4, // German, French, Spanish, Italian (excluding English)
      completed: translations.filter(
        (t) => t.status === TranslationStatus.COMPLETED,
      ).length,
      inProgress: translations.filter(
        (t) => t.status === TranslationStatus.IN_PROGRESS,
      ).length,
      pending: translations.filter(
        (t) => t.status === TranslationStatus.PENDING,
      ).length,
      failed: translations.filter((t) => t.status === TranslationStatus.FAILED)
        .length,
      translations: translations.map((t) => ({
        language: t.language,
        status: t.status,
        completedAt: t.completedAt,
      })),
    };

    return progress;
  }
}
