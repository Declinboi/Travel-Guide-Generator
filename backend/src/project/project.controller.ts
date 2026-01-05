import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ProjectService } from './project.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { QueryProjectDto } from './dto/query-project.dto';
import { ProjectStatus } from '../DB/entities/project.entity';

@ApiTags('projects')
@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new travel guide project' })
  @ApiResponse({ status: 201, description: 'Project created successfully' })
  async create(@Body() createProjectDto: CreateProjectDto) {
    return await this.projectService.create(createProjectDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all projects' })
  @ApiQuery({ name: 'status', enum: ProjectStatus, required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiResponse({ status: 200, description: 'List of all projects' })
  async findAll(@Query() query: QueryProjectDto) {
    return await this.projectService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get project by ID' })
  @ApiResponse({ status: 200, description: 'Project found' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findOne(@Param('id') id: string) {
    return await this.projectService.findOne(id);
  }

  @Get(':id/stats')
  @ApiOperation({ summary: 'Get project statistics' })
  @ApiResponse({ status: 200, description: 'Project statistics' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getStats(@Param('id') id: string) {
    return await this.projectService.getProjectStats(id);
  }

  @Get(':id/images')
  @ApiOperation({ summary: 'Get all images for a project' })
  @ApiResponse({ status: 200, description: 'List of project images' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getImages(@Param('id') id: string) {
    return await this.projectService.getProjectImages(id);
  }

  @Get(':id/chapters')
  @ApiOperation({ summary: 'Get all chapters for a project' })
  @ApiResponse({ status: 200, description: 'List of project chapters' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getChapters(@Param('id') id: string) {
    return await this.projectService.getProjectChapters(id);
  }

  @Get(':id/translations')
  @ApiOperation({ summary: 'Get all translations for a project' })
  @ApiResponse({ status: 200, description: 'List of project translations' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getTranslations(@Param('id') id: string) {
    return await this.projectService.getProjectTranslations(id);
  }

  @Get(':id/documents')
  @ApiOperation({ summary: 'Get all documents for a project' })
  @ApiResponse({ status: 200, description: 'List of project documents' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getDocuments(@Param('id') id: string) {
    return await this.projectService.getProjectDocuments(id);
  }


  @Patch(':id/status')
  @ApiOperation({ summary: 'Update project status' })
  @ApiResponse({ status: 200, description: 'Project status updated' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: ProjectStatus,
  ) {
    return await this.projectService.updateStatus(id, status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete project' })
  @ApiResponse({ status: 204, description: 'Project deleted successfully' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async remove(@Param('id') id: string) {
    await this.projectService.remove(id);
  }
}
