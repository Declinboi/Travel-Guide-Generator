import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project, ProjectStatus } from '../DB/entities/project.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { QueryProjectDto } from './dto/query-project.dto';

@Injectable()
export class ProjectService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
  ) {}

  async create(createProjectDto: CreateProjectDto): Promise<Project> {
    const project = this.projectRepository.create({
      ...createProjectDto,
      status: ProjectStatus.DRAFT,
    });

    return await this.projectRepository.save(project);
  }

  async findAll(query?: QueryProjectDto): Promise<Project[]> {
    const queryBuilder = this.projectRepository
      .createQueryBuilder('project')
      .leftJoinAndSelect('project.user', 'user')
      // .leftJoinAndSelect('project.images', 'images')
      // .leftJoinAndSelect('project.chapters', 'chapters')
      // .leftJoinAndSelect('project.translations', 'translations')
      // .leftJoinAndSelect('project.documents', 'documents')
      .orderBy('project.createdAt', 'DESC');

    if (query?.status) {
      queryBuilder.andWhere('project.status = :status', {
        status: query.status,
      });
    }

    if (query?.userId) {
      queryBuilder.andWhere('project.userId = :userId', {
        userId: query.userId,
      });
    }

    return await queryBuilder.getMany();
  }

  // Basic findOne - only loads essential data
  async findOne(id: string): Promise<Project> {
    const project = await this.projectRepository.findOne({
      where: { id },
      relations: ['user', 'chapters', 'images'],
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    return project;
  }

  // Full project with all relations - use only when needed
  async findOneWithAllRelations(id: string): Promise<Project> {
    const project = await this.projectRepository.findOne({
      where: { id },
      relations: [
        'user',
        'images',
        'chapters',
        'translations',
        'documents',
        'jobs',
      ],
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    return project;
  }

  async getProjectStats(id: string) {
    // Use raw SQL to get counts without loading all data
    const stats = await this.projectRepository
      .createQueryBuilder('project')
      .leftJoin('project.chapters', 'chapters')
      .leftJoin('project.images', 'images')
      .leftJoin('project.translations', 'translations')
      .leftJoin('project.documents', 'documents')
      .leftJoin('project.jobs', 'jobs')
      .select('project.id', 'projectId')
      .addSelect('project.title', 'title')
      .addSelect('project.status', 'status')
      .addSelect('COUNT(DISTINCT chapters.id)', 'totalChapters')
      .addSelect('COUNT(DISTINCT images.id)', 'totalImages')
      .addSelect(
        `COUNT(DISTINCT CASE WHEN translations.status = 'COMPLETED' THEN translations.id END)`,
        'completedTranslations',
      )
      .addSelect('COUNT(DISTINCT translations.id)', 'totalTranslations')
      .addSelect(
        `COUNT(DISTINCT CASE WHEN documents.status = 'COMPLETED' THEN documents.id END)`,
        'completedDocuments',
      )
      .addSelect('COUNT(DISTINCT documents.id)', 'totalDocuments')
      .addSelect(
        `COUNT(DISTINCT CASE WHEN jobs.status IN ('IN_PROGRESS', 'PENDING') THEN jobs.id END)`,
        'activeJobs',
      )
      .addSelect('project.createdAt', 'createdAt')
      .addSelect('project.updatedAt', 'updatedAt')
      .where('project.id = :id', { id })
      .groupBy('project.id')
      .getRawOne();

    if (!stats) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    return {
      projectId: stats.projectId,
      title: stats.title,
      status: stats.status,
      stats: {
        totalChapters: parseInt(stats.totalChapters) || 0,
        totalImages: parseInt(stats.totalImages) || 0,
        completedTranslations: parseInt(stats.completedTranslations) || 0,
        totalTranslations: parseInt(stats.totalTranslations) || 0,
        completedDocuments: parseInt(stats.completedDocuments) || 0,
        totalDocuments: parseInt(stats.totalDocuments) || 0,
        activeJobs: parseInt(stats.activeJobs) || 0,
      },
      createdAt: stats.createdAt,
      updatedAt: stats.updatedAt,
    };
  }

  async updateStatus(id: string, status: ProjectStatus): Promise<Project> {
    const project = await this.findOne(id);
    project.status = status;
    return await this.projectRepository.save(project);
  }

  async remove(id: string): Promise<void> {
    const project = await this.findOne(id);
    await this.projectRepository.remove(project);
  }

  async getProjectImages(id: string) {
    const project = await this.projectRepository.findOne({
      where: { id },
      relations: ['images'],
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    return project.images;
  }

  async getProjectChapters(id: string) {
    const project = await this.projectRepository.findOne({
      where: { id },
      relations: ['chapters'],
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    return project.chapters.sort((a, b) => a.order - b.order);
  }

  async getProjectTranslations(id: string) {
    const project = await this.projectRepository.findOne({
      where: { id },
      relations: ['translations'],
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    return project.translations;
  }

  async getProjectDocuments(id: string) {
    const project = await this.projectRepository.findOne({
      where: { id },
      relations: ['documents'],
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    return project.documents;
  }
}
