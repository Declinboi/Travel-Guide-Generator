// src/book-generator/book.controller.ts
import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseInterceptors,
  UploadedFiles,
  UseGuards,
  Request,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BookGeneratorService } from './book-generator.service';
import { DocumentService } from '../documents/document.service';
import { CreateBookDto } from './create-book.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProjectService } from '../project/project.service';
import { BookGenerationQueue } from 'src/queues/book-generation.queue';

@ApiTags('books')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('books')
export class BookController {
  constructor(
    private readonly bookGenerationQueue: BookGenerationQueue,
    private readonly bookGeneratorService: BookGeneratorService,
    private readonly projectService: ProjectService,
    private readonly documentService: DocumentService,
  ) {}

  @Post('generate')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'images', maxCount: 20 },
      { name: 'mapImage', maxCount: 1 },
    ]),
  )
  @ApiOperation({ summary: 'Generate complete travel guide book (Queue-based)' })
  async generateBook(
    @Body() createBookDto: CreateBookDto,
    @Request() req,
    @UploadedFiles()
    files: {
      images?: Express.Multer.File[];
      mapImage?: Express.Multer.File[];
    },
  ) {
    const userId = req.user.sub;

    // Create project first
    const project = await this.projectService.create({
      title: createBookDto.title,
      subtitle: createBookDto.subtitle,
      author: createBookDto.author,
      numberOfChapters: 10,
      userId: createBookDto.userId || userId,
    });

    // FIXED: Properly serialize buffers to JSON format
    const serializedFiles = {
      images: files.images?.map(f => ({
        buffer: f.buffer.toJSON(), // Convert Buffer to { type: 'Buffer', data: [...] }
        originalname: f.originalname,
        mimetype: f.mimetype,
      })),
      mapImage: files.mapImage?.map(f => ({
        buffer: f.buffer.toJSON(), // Convert Buffer to { type: 'Buffer', data: [...] }
        originalname: f.originalname,
        mimetype: f.mimetype,
      })),
    };

    // Add job to queue
    const jobId = await this.bookGenerationQueue.addBookGenerationJob({
      projectId: project.id,
      createBookDto,
      files: serializedFiles,
    });

    return {
      message: 'Book generation queued successfully! Processing in background.',
      projectId: project.id,
      jobId,
      estimatedTime: '10-15 minutes',
      steps: [
        '1. Generating book content (10 chapters)',
        '2. Processing and positioning images',
        '3. Translating to 4 languages sequentially',
        '4. Creating 10 documents sequentially',
      ],
      statusEndpoint: `/api/books/status/${project.id}`,
      jobStatusEndpoint: `/api/books/job/${jobId}`,
      downloadEndpoint: `/api/books/download/${project.id}`,
    };
  }

  @Get('job/:jobId')
  @ApiOperation({ summary: 'Get queue job status' })
  async getJobStatus(@Param('jobId') jobId: string) {
    return await this.bookGenerationQueue.getJobStatus(jobId);
  }

  @Get('queue/metrics')
  @ApiOperation({ summary: 'Get queue metrics' })
  async getQueueMetrics() {
    return await this.bookGenerationQueue.getQueueMetrics();
  }

  @Get('status/:projectId')
  @ApiOperation({ summary: 'Check book generation status and progress' })
  async getStatus(@Param('projectId') projectId: string) {
    return await this.bookGeneratorService.getBookStatus(projectId);
  }

  @Get('download/:projectId')
  @ApiOperation({ summary: 'Get all download links for generated books' })
  async getDownloads(@Param('projectId') projectId: string) {
    return await this.bookGeneratorService.getDownloadLinks(projectId);
  }

  @Get('download/:projectId/:documentId')
  @ApiOperation({ summary: 'Get document download URL' })
  async getDocumentDownloadUrl(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
  ) {
    const document = await this.documentService.findOne(documentId);

    if (document.projectId !== projectId) {
      throw new Error('Document not found in this project');
    }

    return {
      id: document.id,
      filename: document.filename,
      type: document.type,
      language: document.language,
      size: document.size,
      url: document.url,
      cloudinaryPublicId: document.storageKey,
      createdAt: document.createdAt,
    };
  }
}