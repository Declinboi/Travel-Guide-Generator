import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DocumentService } from './document.service';
import { GenerateDocumentDto, BulkGenerateDocumentsDto } from './dto/generate-document.dto';

@ApiTags('documents')
@Controller('documents')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Post('generate/:projectId')
  @ApiOperation({ summary: 'Generate a single document (PDF or DOCX)' })
  @ApiResponse({ status: 201, description: 'Document generation started' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async generate(
    @Param('projectId') projectId: string,
    @Body() generateDto: GenerateDocumentDto,
  ) {
    return await this.documentService.generateDocument(projectId, generateDto);
  }

  @Post('generate-all/:projectId')
  @ApiOperation({ 
    summary: 'Generate multiple documents for all languages and formats',
    description: 'Generates PDFs and DOCXs for all specified languages (English, German, French, Spanish, Italian)'
  })
  @ApiResponse({ status: 201, description: 'Bulk document generation started' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async generateAll(
    @Param('projectId') projectId: string,
    @Body() bulkDto: BulkGenerateDocumentsDto,
  ) {
    return await this.documentService.generateAllDocuments(projectId, bulkDto);
  }

  @Get('project/:projectId')
  @ApiOperation({ summary: 'Get all documents for a project' })
  @ApiResponse({ status: 200, description: 'List of project documents' })
  async findAllForProject(@Param('projectId') projectId: string) {
    return await this.documentService.findAll(projectId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get document by ID' })
  @ApiResponse({ status: 200, description: 'Document found' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  async findOne(@Param('id') id: string) {
    return await this.documentService.findOne(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete document' })
  @ApiResponse({ status: 204, description: 'Document deleted' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  async remove(@Param('id') id: string) {
    await this.documentService.remove(id);
  }
}