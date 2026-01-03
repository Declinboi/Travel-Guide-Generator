import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { TranslationService } from './translation.service';
import { TranslateProjectDto, BulkTranslateDto } from './dto/translate-project.dto';
import { Language } from 'src/DB/entities';
// import { Language } from '../../entities/translation.entity';

@ApiTags('translation')
@Controller('translation')
export class TranslationController {
  constructor(private readonly translationService: TranslationService) {}

  @Post('translate/:projectId')
  @ApiOperation({ 
    summary: 'Translate project to a single language',
    description: 'Translates the entire book content from English to the specified target language while maintaining the conversational, personal style'
  })
  @ApiResponse({ status: 201, description: 'Translation started' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 400, description: 'Translation already exists or invalid language' })
  async translate(
    @Param('projectId') projectId: string,
    @Body() translateDto: TranslateProjectDto,
  ) {
    return await this.translationService.translateProject(projectId, translateDto);
  }

  @Post('translate-all/:projectId')
  @ApiOperation({ 
    summary: 'Translate project to all languages',
    description: 'Translates to German, French, Spanish, and Italian (4 languages total)'
  })
  @ApiResponse({ status: 201, description: 'Bulk translation started' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async translateAll(
    @Param('projectId') projectId: string,
    @Body() bulkDto: BulkTranslateDto,
  ) {
    return await this.translationService.translateToAllLanguages(projectId, bulkDto);
  }

  @Get('project/:projectId')
  @ApiOperation({ summary: 'Get all translations for a project' })
  @ApiResponse({ status: 200, description: 'List of translations' })
  async findAllForProject(@Param('projectId') projectId: string) {
    return await this.translationService.findAll(projectId);
  }

  @Get('project/:projectId/progress')
  @ApiOperation({ summary: 'Get translation progress for a project' })
  @ApiResponse({ status: 200, description: 'Translation progress summary' })
  async getProgress(@Param('projectId') projectId: string) {
    return await this.translationService.getTranslationProgress(projectId);
  }

  @Get('project/:projectId/language/:language')
  @ApiOperation({ summary: 'Get translation by language' })
  @ApiQuery({ name: 'language', enum: Language })
  @ApiResponse({ status: 200, description: 'Translation found' })
  @ApiResponse({ status: 404, description: 'Translation not found' })
  async findByLanguage(
    @Param('projectId') projectId: string,
    @Param('language') language: Language,
  ) {
    return await this.translationService.findByLanguage(projectId, language);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get translation by ID' })
  @ApiResponse({ status: 200, description: 'Translation found' })
  @ApiResponse({ status: 404, description: 'Translation not found' })
  async findOne(@Param('id') id: string) {
    return await this.translationService.findOne(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete translation' })
  @ApiResponse({ status: 204, description: 'Translation deleted' })
  @ApiResponse({ status: 404, description: 'Translation not found' })
  async remove(@Param('id') id: string) {
    await this.translationService.remove(id);
  }
}