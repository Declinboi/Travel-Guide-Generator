import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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
      .leftJoinAndSelect('project.images', 'images')
      .leftJoinAndSelect('project.chapters', 'chapters')
      .leftJoinAndSelect('project.translations', 'translations')
      .leftJoinAndSelect('project.documents', 'documents')
      .orderBy('project.createdAt', 'DESC');

    if (query?.status) {
      queryBuilder.andWhere('project.status = :status', { status: query.status });
    }

    if (query?.userId) {
      queryBuilder.andWhere('project.userId = :userId', { userId: query.userId });
    }

    return await queryBuilder.getMany();
  }

  async findOne(id: string): Promise<Project> {
    const project = await this.projectRepository.findOne({
      where: { id },
      relations: ['user', 'images', 'chapters', 'translations', 'documents', 'jobs'],
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    return project;
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

  async getProjectStats(id: string) {
    const project = await this.findOne(id);

    return {
      projectId: project.id,
      title: project.title,
      status: project.status,
      stats: {
        totalChapters: project.chapters?.length || 0,
        totalImages: project.images?.length || 0,
        completedTranslations: project.translations?.filter(t => t.status === 'COMPLETED').length || 0,
        totalTranslations: project.translations?.length || 0,
        completedDocuments: project.documents?.filter(d => d.status === 'COMPLETED').length || 0,
        totalDocuments: project.documents?.length || 0,
        activeJobs: project.jobs?.filter(j => j.status === 'IN_PROGRESS' || j.status === 'PENDING').length || 0,
      },
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
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