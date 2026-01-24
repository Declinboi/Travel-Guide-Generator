// src/modules/document/cloudinary-document.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';

@Injectable()
export class CloudinaryDocumentService {
  private readonly logger = new Logger(CloudinaryDocumentService.name);
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000;

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
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        this.logger.log(
          `Upload attempt ${attempt}/${this.MAX_RETRIES} for ${filename}`,
        );

        const result = await this.performUpload(buffer, filename, resourceType);

        if (attempt > 1) {
          this.logger.log(
            `Upload succeeded on attempt ${attempt} for ${filename}`,
          );
        }

        return result;
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `Upload attempt ${attempt}/${this.MAX_RETRIES} failed for ${filename}: ${error.message}`,
        );

        if (attempt < this.MAX_RETRIES) {
          const delay = this.RETRY_DELAY_MS * attempt; // Exponential backoff
          this.logger.log(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    this.logger.error(
      `All ${this.MAX_RETRIES} upload attempts failed for ${filename}`,
    );
    throw lastError || new Error('Upload failed after all retry attempts');
  }

  /**
   * Perform the actual upload operation
   */
  private async performUpload(
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

      // Convert buffer to stream properly using Readable.from()
      const stream = Readable.from(buffer);
      stream.pipe(uploadStream);
    });
  }

  /**
   * Sleep helper for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  /**
   * Get a download URL with attachment flag (forces download instead of opening in browser)
   */
  getDownloadUrl(publicId: string): string {
    return cloudinary.url(publicId, {
      resource_type: 'raw',
      flags: 'attachment', // Force download
      secure: true,
    });
  }

  /**
   * Get a signed download URL (expires after specified time)
   */
  getSignedDownloadUrl(
    publicId: string,
    expiresInSeconds: number = 3600,
  ): string {
    return cloudinary.url(publicId, {
      resource_type: 'raw',
      flags: 'attachment',
      secure: true,
      sign_url: true,
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    });
  }
}
