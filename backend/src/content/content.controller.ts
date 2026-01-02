import {
  Controller,
  Post,
  Body,
  Param,
  Get,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { GenerateTravelGuideDto } from './dto/generate-travel-guide.dto';
import { ContentService } from './content.service';

@ApiTags('content')
@Controller('content')
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Post('generate-travel-guide/:projectId')
  @ApiOperation({ 
    summary: 'Generate complete travel guide book with proper structure',
    description: `Generates a professional travel guide book following this 5-step process:
    
Step 1: Create detailed 10-chapter outline with 3 sections per chapter, 3 subsections per section
Step 2: Write Introduction in simple, engaging prose with personal stories
Step 3: Write each main chapter section by section with narrative style (no lists)
Step 4: Write Conclusion with practical lists and emergency contacts
Step 5: Format with title page, copyright, about book, and table of contents

The book follows the style of professional travel guides with conversational tone, personal anecdotes, and practical advice woven into engaging narratives.`
  })
  @ApiResponse({ 
    status: 201, 
    description: 'Travel guide book generation started. Returns job ID for tracking.' 
  })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async generateTravelGuide(
    @Param('projectId') projectId: string,
    @Body() generateDto: GenerateTravelGuideDto,
  ) {
    return await this.contentService.generateTravelGuideBook(projectId, generateDto);
  }

  @Get('status/:jobId')
  @ApiOperation({ summary: 'Get book generation job status and progress' })
  @ApiResponse({ 
    status: 200, 
    description: 'Job status with progress percentage (0-100)' 
  })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getStatus(@Param('jobId') jobId: string) {
    return await this.contentService.getGenerationStatus(jobId);
  }
}