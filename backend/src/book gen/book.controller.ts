import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseInterceptors,
  UploadedFiles,
  Res,
  NotFoundException,
  UseGuards,
  Request,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { BookGeneratorService } from './book-generator.service';
import * as fs from 'fs';
import { DocumentService } from 'src/documents/document.service';
import { CreateBookDto } from './create-book.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';

@ApiTags('books')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('books')
export class BookController {
  constructor(
    private readonly bookGeneratorService: BookGeneratorService,
    private readonly documentService: DocumentService,
  ) {}

  @Post('generate')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'images', maxCount: 20 },
      { name: 'mapImage', maxCount: 1 },
    ]),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Generate complete travel guide book',
    description: `Upload all information at once:
    1. Title, subtitle, author
    2. Chapter images (10-12 images, auto-distributed)
    3. Map image for last page
    
    System automatically:
    - Generates 10 chapters of content
    - Positions images throughout chapters
    - Translates to 5 languages
    - Creates 10 documents (PDF + DOCX for each language)
    
    Total time: 10-15 minutes`,
  })
  @ApiResponse({ status: 201, description: 'Book generation started' })
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
    return await this.bookGeneratorService.generateCompleteBook(
      createBookDto,
      files,
      userId,
    );
  }

  @Get('status/:projectId')
  @ApiOperation({ summary: 'Check book generation status and progress' })
  @ApiResponse({ status: 200, description: 'Current generation status' })
  async getStatus(@Param('projectId') projectId: string) {
    return await this.bookGeneratorService.getBookStatus(projectId);
  }

  @Get('download/:projectId')
  @ApiOperation({ summary: 'Get all download links for generated books' })
  @ApiResponse({ status: 200, description: 'List of downloadable documents' })
  async getDownloads(@Param('projectId') projectId: string) {
    return await this.bookGeneratorService.getDownloadLinks(projectId);
  }

  @Get('download/:projectId/:documentId')
  @ApiOperation({ summary: 'Get document download URL (Cloudinary)' })
  @ApiResponse({
    status: 200,
    description: 'Document info with Cloudinary URL',
  })
  async getDocumentDownloadUrl(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
  ) {
    const document = await this.documentService.findOne(documentId);

    // Verify document belongs to project
    if (document.projectId !== projectId) {
      throw new NotFoundException('Document not found in this project');
    }

    return {
      id: document.id,
      filename: document.filename,
      type: document.type,
      language: document.language,
      size: document.size,
      // Return Cloudinary URL - frontend can use this directly
      url: document.url,
      cloudinaryPublicId: document.storageKey,
      createdAt: document.createdAt,
    };
  }

  // Optional: Add a redirect endpoint for direct downloads
  @Get('download/:projectId/:documentId/file')
  @ApiOperation({ summary: 'Redirect to Cloudinary download' })
  @ApiResponse({ status: 302, description: 'Redirect to file' })
  async redirectToDownload(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Res() res: Response,
  ) {
    const document = await this.documentService.findOne(documentId);

    // Verify document belongs to project
    if (document.projectId !== projectId) {
      throw new NotFoundException('Document not found in this project');
    }

    // Redirect to Cloudinary URL with download flag
    const downloadUrl = document.url.replace(
      '/upload/',
      '/upload/fl_attachment/',
    );

    res.redirect(downloadUrl);
  }
}
