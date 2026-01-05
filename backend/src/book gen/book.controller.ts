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
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { BookGeneratorService } from './book-generator.service';
import * as fs from 'fs';
import { DocumentService } from 'src/documents/document.service';
import { CreateBookDto } from './create-book.dto';

@ApiTags('books')
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
    @UploadedFiles()
    files: {
      images?: Express.Multer.File[];
      mapImage?: Express.Multer.File[];
    },
  ) {
    return await this.bookGeneratorService.generateCompleteBook(
      createBookDto,
      files,
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
  @ApiOperation({ summary: 'Download a specific document' })
  @ApiResponse({ status: 200, description: 'File download' })
  async downloadDocument(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Res() res: Response,
  ) {
    const document = await this.documentService.findOne(documentId);

    if (!fs.existsSync(document.storageKey)) {
      throw new NotFoundException('File not found');
    }

    res.download(document.storageKey, document.filename);
  }
}
