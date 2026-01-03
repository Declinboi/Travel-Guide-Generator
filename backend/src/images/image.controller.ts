import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { ImageService } from './image.service';
import { UploadImageDto} from './dto/upload-image.dto';

@ApiTags('images')
@Controller('images')
export class ImageController {
  constructor(private readonly imageService: ImageService) {}

  @Post('upload/:projectId')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ 
    summary: 'Upload single image for a project',
    description: 'Upload an image for a specific chapter or as the final map. Images are automatically optimized for 6x9 inch book layout (300 DPI)'
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
        chapterNumber: {
          type: 'number',
          example: 1,
        },
        caption: {
          type: 'string',
          example: 'Beautiful sunset over the mountains',
        },
        position: {
          type: 'number',
          example: 1,
        },
        isMap: {
          type: 'boolean',
          example: false,
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Image uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid file or bad request' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async uploadImage(
    @Param('projectId') projectId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() uploadDto: UploadImageDto,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    return await this.imageService.uploadImage(projectId, file, uploadDto);
  }

  @Post('upload-multiple/:projectId')
  @UseInterceptors(FilesInterceptor('files', 20))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ 
    summary: 'Upload multiple images at once',
    description: 'Upload up to 20 images for a project'
  })
  @ApiResponse({ status: 201, description: 'Images uploaded successfully' })
  async uploadMultiple(
    @Param('projectId') projectId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() uploadDtos: UploadImageDto[],
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }

    return await this.imageService.uploadMultipleImages(projectId, files, uploadDtos);
  }

  @Get('project/:projectId')
  @ApiOperation({ summary: 'Get all images for a project' })
  @ApiResponse({ status: 200, description: 'List of images' })
  async findAll(@Param('projectId') projectId: string) {
    return await this.imageService.findAll(projectId);
  }

  @Get('project/:projectId/chapter/:chapterNumber')
  @ApiOperation({ summary: 'Get images for a specific chapter' })
  @ApiResponse({ status: 200, description: 'List of chapter images' })
  async findByChapter(
    @Param('projectId') projectId: string,
    @Param('chapterNumber') chapterNumber: number,
  ) {
    return await this.imageService.findByChapter(projectId, chapterNumber);
  }

  @Get('project/:projectId/map')
  @ApiOperation({ summary: 'Get the final map for a project' })
  @ApiResponse({ status: 200, description: 'Map image' })
  @ApiResponse({ status: 404, description: 'Map not found' })
  async findMap(@Param('projectId') projectId: string) {
    return await this.imageService.findMap(projectId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get image by ID' })
  @ApiResponse({ status: 200, description: 'Image found' })
  @ApiResponse({ status: 404, description: 'Image not found' })
  async findOne(@Param('id') id: string) {
    return await this.imageService.findOne(id);
  }


  @Post('reorder/:projectId')
  @ApiOperation({ 
    summary: 'Reorder images within a project',
    description: 'Update the position of multiple images'
  })
  @ApiResponse({ status: 200, description: 'Images reordered successfully' })
  async reorder(
    @Param('projectId') projectId: string,
    @Body() imageOrders: { id: string; position: number }[],
  ) {
    return await this.imageService.reorderImages(projectId, imageOrders);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete image' })
  @ApiResponse({ status: 204, description: 'Image deleted successfully' })
  @ApiResponse({ status: 404, description: 'Image not found' })
  async remove(@Param('id') id: string) {
    await this.imageService.remove(id);
  }

  @Delete('project/:projectId/all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete all images from a project' })
  @ApiResponse({ status: 204, description: 'All images deleted successfully' })
  async removeAll(@Param('projectId') projectId: string) {
    await this.imageService.removeAllFromProject(projectId);
  }
}