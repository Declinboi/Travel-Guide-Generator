import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse, UploadApiErrorResponse } from 'cloudinary';
import * as streamifier from 'streamifier';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(private configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get('CLOUDINARY_API_SECRET'),
    });
  }

  async uploadImage(
    file: Express.Multer.File,
    isMap: boolean = false,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      // Calculate dimensions for 6x9 inch book
      // At 300 DPI: 6 inches = 1800px, 9 inches = 2700px
      // For regular images, use content width (approx 5 inches = 1500px)
      // For maps, use full page (6 inches = 1800px width)
      
      const transformation = isMap
        ? {
            // Full page map - 6x9 inches at 300 DPI
            width: 1800,
            height: 2700,
            crop: 'fill',
            quality: 'auto:best',
            format: 'jpg',
          }
        : {
            // Regular chapter image - content width at 300 DPI
            width: 1500,
            height: 1000,
            crop: 'limit', // Don't enlarge, just limit max size
            quality: 'auto:good',
            format: 'jpg',
          };

      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'travel-guides',
          transformation: [transformation],
          resource_type: 'image',
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
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Invalid file type. Only JPEG, PNG, and WebP images are allowed.',
      );
    }

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      throw new BadRequestException(
        'File too large. Maximum size is 10MB.',
      );
    }
  }
}