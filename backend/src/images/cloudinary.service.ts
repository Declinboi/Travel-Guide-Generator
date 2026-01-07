// src/modules/image/cloudinary.service.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  v2 as cloudinary,
  UploadApiResponse,
  UploadApiErrorResponse,
} from 'cloudinary';
import * as streamifier from 'streamifier';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(private configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get('CLOUDINARY_API_SECRET'),
      // Increase timeout to 120 seconds
      timeout: 120000,
    });
  }

  async uploadImage(
    file: Express.Multer.File,
    isMap: boolean = false,
    retries: number = 3,
  ): Promise<UploadApiResponse> {
    let lastError: any;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.logger.log(
          `Upload attempt ${attempt}/${retries} for ${file.originalname}`,
        );

        return await this.performUpload(file, isMap);
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `Upload attempt ${attempt}/${retries} failed for ${file.originalname}: ${error.message}`,
        );

        if (attempt < retries) {
          // Wait before retrying (exponential backoff)
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          this.logger.log(`Waiting ${delay}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All retries failed
    this.logger.error(`All upload attempts failed for ${file.originalname}`);
    throw lastError;
  }

  private async performUpload(
    file: Express.Multer.File,
    isMap: boolean,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      // Calculate dimensions for 6x9 inch book
      const transformation = isMap
        ? {
            width: 1800,
            height: 2700,
            crop: 'fill',
            quality: 'auto:best',
            format: 'jpg',
          }
        : {
            width: 1500,
            height: 1000,
            crop: 'limit',
            quality: 'auto:good',
            format: 'jpg',
          };

      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'travel-guides',
          transformation: [transformation],
          resource_type: 'image',
          timeout: 120000, // 120 second timeout per upload
        },
        (error: UploadApiErrorResponse, result: UploadApiResponse) => {
          if (error) {
            this.logger.error('Cloudinary upload error:', error);
            reject(error);
          } else {
            this.logger.log(`Image uploaded: ${result.secure_url}`);
            resolve(result);
          }
        },
      );

      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  async uploadMultipleImagesParallel(
    files: Express.Multer.File[],
    isMap: boolean = false,
    concurrency: number = 3, // Upload 3 images at a time
  ): Promise<UploadApiResponse[]> {
    const results: UploadApiResponse[] = [];
    const errors: { file: string; error: any }[] = [];

    // Process in batches for controlled concurrency
    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency);
      this.logger.log(
        `Processing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(files.length / concurrency)}: ${batch.length} images`,
      );

      const batchPromises = batch.map(async (file) => {
        try {
          const result = await this.uploadImage(file, isMap);
          results.push(result);
          return result;
        } catch (error) {
          this.logger.error(`Failed to upload ${file.originalname}:`, error);
          errors.push({ file: file.originalname, error });
          return null;
        }
      });

      await Promise.all(batchPromises);
    }

    if (errors.length > 0) {
      this.logger.warn(
        `${errors.length} of ${files.length} images failed to upload`,
      );
    }

    return results.filter((r) => r !== null);
  }

  async deleteImage(publicId: string): Promise<void> {
    try {
      const result = await cloudinary.uploader.destroy(publicId);
      this.logger.log(`Image deleted: ${publicId}`);
      return result;
    } catch (error) {
      this.logger.error('Error deleting image:', error);
      throw error;
    }
  }

  async getImageUrl(publicId: string, transformation?: any): Promise<string> {
    return cloudinary.url(publicId, transformation);
  }

  validateImageFile(file: Express.Multer.File): void {
    // Check file type
    const allowedMimeTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
    ];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Invalid file type. Only JPEG, PNG, and WebP images are allowed.',
      );
    }

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      throw new BadRequestException('File too large. Maximum size is 10MB.');
    }
  }
}
