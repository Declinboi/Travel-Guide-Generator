// src/modules/document/cloudinary-document.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';

@Injectable()
export class CloudinaryDocumentService {
  private readonly logger = new Logger(CloudinaryDocumentService.name);

  constructor(private configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get('CLOUDINARY_API_SECRET'),
    });
  }

  /**
   * Upload document buffer to Cloudinary
   * @param buffer Document buffer (PDF or DOCX)
   * @param filename Original filename
   * @param resourceType 'raw' for non-image files
   * @returns Cloudinary upload result with secure URL
   */
  async uploadDocument(
    buffer: Buffer,
    filename: string,
    resourceType: 'raw' = 'raw',
  ): Promise<{
    url: string;
    publicId: string;
    size: number;
    format: string;
  }> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: resourceType,
          folder: 'documents', // Organize in a folder
          public_id: this.sanitizeFilename(filename),
          format: this.getFileExtension(filename),
          // Optional: Add tags for better organization
          tags: ['generated-document'],
        },
        (error, result) => {
          if (error) {
            this.logger.error('Cloudinary upload error:', error);
            reject(error);
          } else if (!result) {
            this.logger.error('Cloudinary upload failed: No result returned');
            reject(new Error('Upload failed: No result from Cloudinary'));
          } else {
            this.logger.log(
              `Document uploaded to Cloudinary: ${result.secure_url}`,
            );
            resolve({
              url: result.secure_url,
              publicId: result.public_id,
              size: result.bytes,
              format: result.format,
            });
          }
        },
      );

      // Convert buffer to stream and pipe to Cloudinary
      const readableStream = new Readable();
      readableStream.push(buffer);
      readableStream.push(null);
      readableStream.pipe(uploadStream);
    });
  }

  /**
   * Delete document from Cloudinary
   * @param publicId Cloudinary public ID
   * @param resourceType 'raw' for non-image files
   */
  async deleteDocument(
    publicId: string,
    resourceType: 'raw' = 'raw',
  ): Promise<void> {
    try {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
      });

      if (result.result === 'ok') {
        this.logger.log(`Document deleted from Cloudinary: ${publicId}`);
      } else {
        this.logger.warn(
          `Failed to delete document from Cloudinary: ${publicId}`,
        );
      }
    } catch (error) {
      this.logger.error('Error deleting document from Cloudinary:', error);
      throw error;
    }
  }

  private sanitizeFilename(filename: string): string {
    // Remove extension and sanitize
    return filename
      .replace(/\.(pdf|docx)$/i, '')
      .replace(/[^a-z0-9]/gi, '_')
      .replace(/_+/g, '_')
      .toLowerCase();
  }

  private getFileExtension(filename: string): string {
    const match = filename.match(/\.(pdf|docx)$/i);
    return match ? match[1].toLowerCase() : 'pdf';
  }
}
