// src/modules/image/image.service.ts
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CloudinaryService } from './cloudinary.service';
import { UploadImageDto } from './dto/upload-image.dto';
import { Chapter, Image, Project } from 'src/DB/entities';

@Injectable()
export class ImageService {
  private readonly logger = new Logger(ImageService.name);

  constructor(
    @InjectRepository(Image)
    private readonly imageRepository: Repository<Image>,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Chapter)
    private readonly chapterRepository: Repository<Chapter>,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async uploadImage(
    projectId: string,
    file: Express.Multer.File,
    uploadDto: UploadImageDto,
  ) {
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    // Validate file
    this.cloudinaryService.validateImageFile(file);

    // If chapter number is provided, validate it exists
    if (uploadDto.chapterNumber) {
      const chapter = await this.chapterRepository.findOne({
        where: { projectId, order: uploadDto.chapterNumber },
      });

      if (!chapter) {
        throw new NotFoundException(
          `Chapter ${uploadDto.chapterNumber} not found in this project`,
        );
      }

      // Auto-calculate position for this chapter
      const existingImagesInChapter = await this.imageRepository.find({
        where: {
          projectId,
          chapterNumber: uploadDto.chapterNumber,
          isMap: false,
        },
        order: { position: 'DESC' },
      });

      uploadDto.position =
        existingImagesInChapter.length > 0
          ? (existingImagesInChapter[0].position || 0) + 1
          : 1;
    }

    // Check if map already exists for this project
    if (uploadDto.isMap) {
      const existingMap = await this.imageRepository.findOne({
        where: { projectId, isMap: true },
      });

      if (existingMap) {
        throw new BadRequestException(
          'Project already has a map. Delete the existing map first or update it.',
        );
      }
    }

    // Upload to Cloudinary with retries
    const uploadResult = await this.cloudinaryService.uploadImage(
      file,
      uploadDto.isMap,
    );

    // Create image record
    const image = this.imageRepository.create({
      projectId,
      filename: uploadResult.public_id,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      url: uploadResult.secure_url,
      storageKey: uploadResult.public_id,
      position: uploadDto.position,
      caption: uploadDto.caption,
      chapterNumber: uploadDto.chapterNumber,
      isMap: uploadDto.isMap || false,
    });

    const savedImage = await this.imageRepository.save(image);

    this.logger.log(
      `Image uploaded for project ${projectId}: ${uploadDto.isMap ? 'MAP' : `Chapter ${uploadDto.chapterNumber} - Position ${uploadDto.position}`} - ${file.originalname}`,
    );

    return savedImage;
  }

  async uploadMultipleImages(
    projectId: string,
    files: Express.Multer.File[],
    uploadDtos: UploadImageDto[],
  ) {
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    this.logger.log(
      `Starting batch upload of ${files.length} images for project ${projectId}`,
    );

    // Validate all files first
    for (const file of files) {
      this.cloudinaryService.validateImageFile(file);
    }

    // Upload to Cloudinary in parallel batches (3 at a time)
    const uploadResults =
      await this.cloudinaryService.uploadMultipleImagesParallel(
        files,
        false,
        3, // Upload 3 images concurrently
      );

    this.logger.log(
      `Successfully uploaded ${uploadResults.length}/${files.length} images to Cloudinary`,
    );

    // Save to database
    const uploadedImages: Image[] = [];
    const errors: { file: string; error: string }[] = [];

    for (let i = 0; i < uploadResults.length; i++) {
      const result = uploadResults[i];
      if (!result) continue;

      const file = files[i];
      const dto = uploadDtos[i] || {};

      try {
        // Calculate chapter and position
        if (dto.chapterNumber) {
          const existingImagesInChapter = await this.imageRepository.find({
            where: {
              projectId,
              chapterNumber: dto.chapterNumber,
              isMap: false,
            },
            order: { position: 'DESC' },
          });

          dto.position =
            existingImagesInChapter.length > 0
              ? (existingImagesInChapter[0].position || 0) + 1
              : 1;
        }

        const image = this.imageRepository.create({
          projectId,
          filename: result.public_id,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: result.secure_url,
          storageKey: result.public_id,
          position: dto.position,
          caption: dto.caption,
          chapterNumber: dto.chapterNumber,
          isMap: dto.isMap || false,
        });

        const savedImage = await this.imageRepository.save(image);
        uploadedImages.push(savedImage);
      } catch (error) {
        errors.push({
          file: file.originalname,
          error: error.message,
        });
        this.logger.error(
          `Failed to save image record for ${file.originalname}:`,
          error,
        );
      }
    }

    this.logger.log(`Saved ${uploadedImages.length} image records to database`);

    return {
      message: `${uploadedImages.length} of ${files.length} images uploaded successfully`,
      images: uploadedImages,
      errors: errors.length > 0 ? errors : undefined,
      success: uploadedImages.length,
      failed: errors.length,
    };
  }

  async findAll(projectId: string) {
    return await this.imageRepository.find({
      where: { projectId },
      order: { chapterNumber: 'ASC', position: 'ASC' },
    });
  }

  async findByChapter(projectId: string, chapterNumber: number) {
    return await this.imageRepository.find({
      where: { projectId, chapterNumber },
      order: { position: 'ASC' },
    });
  }

  async findMap(projectId: string) {
    const map = await this.imageRepository.findOne({
      where: { projectId, isMap: true },
    });

    if (!map) {
      throw new NotFoundException('No map found for this project');
    }

    return map;
  }

  async findOne(id: string) {
    const image = await this.imageRepository.findOne({
      where: { id },
      relations: ['project'],
    });

    if (!image) {
      throw new NotFoundException(`Image with ID ${id} not found`);
    }

    return image;
  }

  async reorderImages(
    projectId: string,
    imageOrders: { id: string; position: number }[],
  ) {
    const updates: Promise<Image>[] = [];

    for (const order of imageOrders) {
      const image = await this.imageRepository.findOne({
        where: { id: order.id, projectId },
      });

      if (image) {
        image.position = order.position;
        updates.push(this.imageRepository.save(image));
      }
    }

    await Promise.all(updates);

    return {
      message: `${updates.length} images reordered successfully`,
    };
  }

  async remove(id: string) {
    const image = await this.findOne(id);

    // Delete from Cloudinary
    await this.cloudinaryService.deleteImage(image.storageKey);

    // Delete from database
    await this.imageRepository.remove(image);

    this.logger.log(`Image deleted: ${image.filename}`);
  }

  async removeAllFromProject(projectId: string) {
    const images = await this.findAll(projectId);

    for (const image of images) {
      await this.cloudinaryService.deleteImage(image.storageKey);
    }

    await this.imageRepository.delete({ projectId });

    return {
      message: `${images.length} images deleted from project`,
    };
  }
}
