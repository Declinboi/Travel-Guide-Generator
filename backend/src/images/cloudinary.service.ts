// src/modules/image/cloudinary.service.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  v2 as cloudinary,
  UploadApiResponse,
  UploadApiErrorResponse,
} from 'cloudinary';
import { Readable } from 'stream';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private readonly DEFAULT_UPLOAD_TIMEOUT_MS = 300000;
  private readonly MAX_RETRIES = 6;
  private readonly RETRY_DELAY_MS = 5000;

  constructor(private configService: ConfigService) {
    const uploadTimeout = this.getUploadTimeoutMs();

    cloudinary.config({
      cloud_name: this.configService.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get('CLOUDINARY_API_SECRET'),
      timeout: uploadTimeout,
    });
  }

  async uploadImage(
    file: Express.Multer.File,
    isMap: boolean = false,
    retries: number = this.MAX_RETRIES,
  ): Promise<UploadApiResponse> {
    let lastError: any;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.logger.log(
          `Upload attempt ${attempt}/${retries} for ${file.originalname} (${this.formatSize(this.getFileSize(file))})`,
        );

        return await this.performUpload(file, isMap);
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `Upload attempt ${attempt}/${retries} failed for ${file.originalname}: ${error.message}`,
        );

        if (attempt < retries) {
          const delay = this.getUploadRetryDelay(attempt);
          this.logger.log(
            `Waiting ${Math.round(delay / 1000)}s before retry...`,
          );
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
      let settled = false;
      const uploadTimeout = this.getUploadTimeoutMs();
      let localTimeout: NodeJS.Timeout;

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
          timeout: uploadTimeout,
        },
        (
          error: UploadApiErrorResponse | undefined,
          result: UploadApiResponse | undefined,
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(localTimeout);

          if (error) {
            this.logger.error('Cloudinary upload error:', error);
            reject(error);
          } else if (!result) {
            this.logger.error('Cloudinary upload failed: No result returned');
            reject(new Error('Upload failed: No result from Cloudinary'));
          } else {
            this.logger.log(`Image uploaded: ${result.secure_url}`);
            resolve(result);
          }
        },
      );

      localTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        uploadStream.destroy(
          new Error(`Cloudinary upload timed out after ${uploadTimeout}ms`),
        );
        reject(new Error(`Cloudinary upload timed out after ${uploadTimeout}ms`));
      }, uploadTimeout + 5000);

      uploadStream.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(localTimeout);
        reject(error);
      });

      Readable.from(file.buffer).pipe(uploadStream);
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
    if (this.getFileSize(file) > maxSize) {
      throw new BadRequestException('File too large. Maximum size is 10MB.');
    }
  }

  private getUploadTimeoutMs(): number {
    const configuredTimeout = Number(
      this.configService.get('CLOUDINARY_IMAGE_UPLOAD_TIMEOUT_MS') ??
        this.configService.get('CLOUDINARY_UPLOAD_TIMEOUT_MS'),
    );

    return Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : this.DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  private getUploadRetryDelay(attempt: number): number {
    const baseDelay = this.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 3000);
    return Math.min(baseDelay + jitter, 60000);
  }

  private getFileSize(file: Express.Multer.File): number {
    return file.size || file.buffer?.length || 0;
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}
