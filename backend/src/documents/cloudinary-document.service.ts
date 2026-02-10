// src/modules/document/cloudinary-document.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';
import sharp from 'sharp';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

@Injectable()
export class CloudinaryDocumentService {
  private readonly logger = new Logger(CloudinaryDocumentService.name);
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000;
  private readonly IMAGE_QUALITY = 30; // Reduce quality only, no resizing
  private readonly hasGhostscript: boolean;

  constructor(private configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get('CLOUDINARY_API_SECRET'),
    });

    this.hasGhostscript = this.checkGhostscript();
    if (this.hasGhostscript) {
      this.logger.log('✅ Ghostscript detected - will use for PDF compression');
    } else {
      this.logger.warn(
        '⚠️ Ghostscript not found - PDF compression will be limited',
      );
    }
  }

  private checkGhostscript(): boolean {
    try {
      require('child_process').execSync('gs --version', { stdio: 'ignore' });
      return true;
    } catch {
      try {
        require('child_process').execSync('gswin64c --version', {
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Compress document - reduce image quality only, preserve structure
   */
  private async compressDocument(
    buffer: Buffer,
    filename: string,
  ): Promise<Buffer> {
    const extension = filename.toLowerCase().split('.').pop();
    const originalSize = buffer.length;

    this.logger.log(
      `🗜️ Compressing ${filename} (${this.formatSize(originalSize)}) - Quality reduction only...`,
    );

    try {
      let compressedBuffer: Buffer;
      let compressionMethod: string;

      if (extension === 'pdf') {
        if (this.hasGhostscript) {
          compressedBuffer = await this.compressPDFWithGhostscript(buffer);
          compressionMethod = 'Ghostscript';
        } else {
          this.logger.warn(
            'Ghostscript not available, PDF compression skipped',
          );
          return buffer;
        }
      } else if (extension === 'docx') {
        compressedBuffer = await this.compressDOCXQualityOnly(buffer);
        compressionMethod = 'DOCX Quality Reduction';
      } else {
        return buffer;
      }

      const savedBytes = originalSize - compressedBuffer.length;
      const compressionRatio = (savedBytes / originalSize) * 100;

      if (compressedBuffer.length < originalSize) {
        const status =
          compressionRatio >= 70 ? '✅' : compressionRatio >= 50 ? '🟡' : '⚠️';
        this.logger.log(
          `${status} [${compressionMethod}] ${this.formatSize(originalSize)} -> ${this.formatSize(compressedBuffer.length)} (${compressionRatio.toFixed(1)}% reduction)`,
        );
        return compressedBuffer;
      } else {
        this.logger.log(`Compression ineffective, using original`);
        return buffer;
      }
    } catch (error) {
      this.logger.error(`Compression failed: ${error.message}`);
      return buffer;
    }
  }

  /**
   * Compress PDF using Ghostscript - preserves layout, reduces image quality
   */
  private async compressPDFWithGhostscript(buffer: Buffer): Promise<Buffer> {
    const tempDir = os.tmpdir();
    const inputPath = path.join(tempDir, `input_${Date.now()}.pdf`);
    const outputPath = path.join(tempDir, `output_${Date.now()}.pdf`);

    try {
      fs.writeFileSync(inputPath, buffer);

      const gsCommand = process.platform === 'win32' ? 'gswin64c' : 'gs';

      // Ghostscript settings that preserve layout but reduce image quality
      const command = [
        gsCommand,
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        '-dNOPAUSE',
        '-dQUIET',
        '-dBATCH',
        // Image quality settings (no resizing, just quality reduction)
        '-dColorImageDownsampleType=/Bicubic',
        '-dColorImageResolution=150', // Keep reasonable resolution
        '-dGrayImageDownsampleType=/Bicubic',
        '-dGrayImageResolution=150',
        '-dMonoImageDownsampleType=/Subsample',
        '-dMonoImageResolution=150',
        // Compression settings
        '-dCompressFonts=true',
        '-dEmbedAllFonts=true',
        '-dSubsetFonts=true',
        // JPEG quality for images (lower = more compression)
        '-dJPEGQ=30',
        '-dAutoFilterColorImages=false',
        '-dAutoFilterGrayImages=false',
        '-dColorImageFilter=/DCTEncode',
        '-dGrayImageFilter=/DCTEncode',
        // Preserve structure
        '-dPreserveAnnots=true',
        '-dPreserveOPIComments=true',
        '-dPreserveOverprintSettings=true',
        `-sOutputFile="${outputPath}"`,
        `"${inputPath}"`,
      ].join(' ');

      await new Promise<void>((resolve, reject) => {
        exec(command, { timeout: 180000 }, (error, stdout, stderr) => {
          if (error) {
            this.logger.warn(`Ghostscript warning: ${stderr || error.message}`);
            reject(error);
          } else {
            resolve();
          }
        });
      });

      if (!fs.existsSync(outputPath)) {
        throw new Error('Ghostscript output file not created');
      }

      const compressedBuffer = fs.readFileSync(outputPath);

      // Cleanup
      try {
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
      } catch {}

      return compressedBuffer;
    } catch (error) {
      // Cleanup on error
      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch {}

      this.logger.error(`Ghostscript compression failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Compress DOCX - reduce image quality only, preserve dimensions and structure
   */
  private async compressDOCXQualityOnly(buffer: Buffer): Promise<Buffer> {
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(buffer);

      let totalSaved = 0;
      let imagesProcessed = 0;

      // Find all images
      const imageFiles = Object.keys(zip.files).filter(
        (name) =>
          name.startsWith('word/media/') &&
          /\.(png|jpg|jpeg|gif|bmp|tiff|webp)$/i.test(name),
      );

      this.logger.log(`Found ${imageFiles.length} images in DOCX`);

      for (const imagePath of imageFiles) {
        try {
          const imageData = await zip.file(imagePath)?.async('nodebuffer');
          if (!imageData || imageData.length < 1024) continue;

          const originalSize = imageData.length;

          // Compress image - QUALITY ONLY, NO RESIZING
          const compressedImage =
            await this.compressImageQualityOnly(imageData);

          if (compressedImage && compressedImage.length < originalSize) {
            // Replace with compressed version (keep same path for PNG->JPEG conversion)
            const newPath = imagePath.replace(
              /\.(png|gif|bmp|tiff|webp)$/i,
              '.jpeg',
            );

            if (newPath !== imagePath) {
              zip.remove(imagePath);
              // Update relationships
              await this.updateDocxRelationships(zip, imagePath, newPath);
            }

            zip.file(newPath, compressedImage);
            totalSaved += originalSize - compressedImage.length;
            imagesProcessed++;

            this.logger.debug(
              `Compressed ${path.basename(imagePath)}: ${this.formatSize(originalSize)} -> ${this.formatSize(compressedImage.length)}`,
            );
          }
        } catch (imgError) {
          this.logger.debug(`Skipping ${imagePath}: ${imgError.message}`);
        }
      }

      // Update content types if we converted any images to JPEG
      if (imagesProcessed > 0) {
        await this.updateDocxContentTypes(zip);
      }

      this.logger.log(
        `Processed ${imagesProcessed} images, saved ${this.formatSize(totalSaved)}`,
      );

      // Re-compress ZIP with maximum deflation
      const compressedBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });

      return compressedBuffer;
    } catch (error) {
      this.logger.error(`DOCX compression error: ${error.message}`);
      return buffer;
    }
  }

  /**
   * Compress image - QUALITY REDUCTION ONLY, NO RESIZING
   */
  private async compressImageQualityOnly(
    imageBuffer: Buffer,
  ): Promise<Buffer | null> {
    try {
      const metadata = await sharp(imageBuffer).metadata();

      if (!metadata.width || !metadata.height) {
        return null;
      }

      // Keep original dimensions, only reduce quality
      const compressed = await sharp(imageBuffer)
        .jpeg({
          quality: this.IMAGE_QUALITY,
          progressive: true,
          mozjpeg: true,
          chromaSubsampling: '4:2:0',
          trellisQuantisation: true,
          overshootDeringing: true,
          optimizeScans: true,
        })
        .toBuffer();

      return compressed;
    } catch (error) {
      // Fallback: basic JPEG compression
      try {
        return await sharp(imageBuffer)
          .jpeg({ quality: this.IMAGE_QUALITY })
          .toBuffer();
      } catch {
        return null;
      }
    }
  }

  /**
   * Update DOCX relationships when image extension changes
   */
  private async updateDocxRelationships(
    zip: any,
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const oldName = path.basename(oldPath);
    const newName = path.basename(newPath);

    if (oldName === newName) return;

    const relsFiles = Object.keys(zip.files).filter((name) =>
      name.endsWith('.rels'),
    );

    for (const relsFile of relsFiles) {
      try {
        let content = await zip.file(relsFile)?.async('string');
        if (content && content.includes(oldName)) {
          content = content.replace(
            new RegExp(oldName.replace('.', '\\.'), 'g'),
            newName,
          );
          zip.file(relsFile, content);
        }
      } catch {}
    }
  }

  /**
   * Update DOCX content types for JPEG images
   */
  private async updateDocxContentTypes(zip: any): Promise<void> {
    try {
      let contentTypes = await zip.file('[Content_Types].xml')?.async('string');
      if (contentTypes && !contentTypes.includes('Extension="jpeg"')) {
        contentTypes = contentTypes.replace(
          '</Types>',
          '<Default Extension="jpeg" ContentType="image/jpeg"/></Types>',
        );
        zip.file('[Content_Types].xml', contentTypes);
      }
    } catch {}
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  /**
   * Upload document buffer to Cloudinary (with compression)
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
    originalSize: number;
    compressedSize: number;
    compressionRatio: number;
  }> {
    const originalSize = buffer.length;

    const compressedBuffer = await this.compressDocument(buffer, filename);
    const compressedSize = compressedBuffer.length;
    const compressionRatio =
      ((originalSize - compressedSize) / originalSize) * 100;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        this.logger.log(
          `Upload attempt ${attempt}/${this.MAX_RETRIES} for ${filename} (${this.formatSize(compressedSize)})`,
        );

        const result = await this.performUpload(
          compressedBuffer,
          filename,
          resourceType,
        );

        return {
          ...result,
          originalSize,
          compressedSize,
          compressionRatio: Math.round(compressionRatio * 100) / 100,
        };
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `Upload attempt ${attempt}/${this.MAX_RETRIES} failed: ${error.message}`,
        );

        if (attempt < this.MAX_RETRIES) {
          await this.sleep(this.RETRY_DELAY_MS * attempt);
        }
      }
    }

    throw lastError || new Error('Upload failed after all retry attempts');
  }

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
          folder: 'documents',
          public_id: this.sanitizeFilename(filename),
          tags: ['generated-document', 'compressed'],
        },
        (error, result) => {
          if (error) {
            reject(error);
          } else if (!result) {
            reject(new Error('Upload failed: No result from Cloudinary'));
          } else {
            this.logger.log(`Document uploaded: ${result.secure_url}`);
            resolve({
              url: result.secure_url,
              publicId: result.public_id,
              size: result.bytes,
              format: result.format,
            });
          }
        },
      );

      Readable.from(buffer).pipe(uploadStream);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async deleteDocument(
    publicId: string,
    resourceType: 'raw' = 'raw',
  ): Promise<void> {
    try {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
      });

      if (result.result === 'ok') {
        this.logger.log(`Document deleted: ${publicId}`);
      }
    } catch (error) {
      this.logger.error('Error deleting document:', error);
      throw error;
    }
  }

  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/\.(pdf|docx)$/i, '')
      .replace(/[^a-z0-9]/gi, '_')
      .replace(/_+/g, '_')
      .toLowerCase();
  }

  getDownloadUrl(publicId: string): string {
    return cloudinary.url(publicId, {
      resource_type: 'raw',
      flags: 'attachment',
      secure: true,
    });
  }

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
