// src/modules/document/pdf.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private readonly storagePath: string;

  constructor(private configService: ConfigService) {
    this.storagePath =
      this.configService.get('STORAGE_PATH') || './storage/documents';

    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
  }

  async generatePDF(
    title: string,
    subtitle: string,
    author: string,
    chapters: any[],
    images: any[] = [],
  ): Promise<{ filename: string; filepath: string; size: number }> {
    return new Promise(async (resolve, reject) => {
      try {
        const filename = `${this.sanitizeFilename(title)}_${Date.now()}.pdf`;
        const filepath = path.join(this.storagePath, filename);

        // 6x9 inches = 432x648 points (72 points per inch)
        const doc = new PDFDocument({
          size: [432, 648],
          margins: { top: 36, bottom: 36, left: 36, right: 36 },
          info: {
            Title: title,
            Author: author,
          },
        });

        const writeStream = fs.createWriteStream(filepath);
        doc.pipe(writeStream);

        // Title Page
        doc
          .fontSize(28)
          .font('Helvetica-Bold')
          .text(title, { align: 'center' });
        doc.moveDown();

        if (subtitle) {
          doc
            .fontSize(16)
            .font('Helvetica')
            .text(subtitle, { align: 'center' });
          doc.moveDown(2);
        }

        doc.fontSize(14).text(`By ${author}`, { align: 'center' });
        doc.addPage();

        // Copyright Page
        const copyrightChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('copyright'),
        );
        if (copyrightChapter) {
          doc.fontSize(10).font('Helvetica').text(copyrightChapter.content);
          doc.addPage();
        }

        // About Book
        const aboutChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('about'),
        );
        if (aboutChapter) {
          doc.fontSize(16).font('Helvetica-Bold').text('About This Book');
          doc.moveDown();
          doc
            .fontSize(11)
            .font('Helvetica')
            .text(aboutChapter.content, { align: 'justify' });
          doc.addPage();
        }

        // Table of Contents
        const tocChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('table'),
        );
        if (tocChapter) {
          doc.fontSize(20).font('Helvetica-Bold').text('Table of Contents');
          doc.moveDown();
          doc.fontSize(11).font('Helvetica').text(tocChapter.content);
          doc.addPage();
        }

        // Main Chapters with Images
        const mainChapters = chapters
          .filter(
            (c) =>
              !['title', 'copyright', 'about', 'table'].some((keyword) =>
                c.title.toLowerCase().includes(keyword),
              ),
          )
          .sort((a, b) => a.order - b.order);

        for (let i = 0; i < mainChapters.length; i++) {
          const chapter = mainChapters[i];
          const chapterNumber = chapter.order - 3; // Adjust for front matter

          // Chapter Title
          doc.fontSize(22).font('Helvetica-Bold').text(chapter.title);
          doc.moveDown(1.5);

          // Get images for this chapter
          const chapterImages = images
            .filter((img) => img.chapterNumber === chapterNumber && !img.isMap)
            .sort((a, b) => (a.position || 0) - (b.position || 0));

          // Insert images throughout chapter content
          if (chapterImages.length > 0) {
            await this.insertImagesInContent(
              doc,
              chapter.content,
              chapterImages,
            );
          } else {
            // No images, just add content
            const content = this.formatContentForPDF(chapter.content);
            doc.fontSize(11).font('Helvetica').text(content, {
              align: 'justify',
              lineGap: 5,
            });
          }

          // Add page break if not last chapter
          if (i < mainChapters.length - 1) {
            doc.addPage();
          }
        }

        // Add Map on Last Page (if exists)
        const mapImage = images.find((img) => img.isMap);
        if (mapImage) {
          doc.addPage();
          await this.insertFullPageImage(doc, mapImage);
        }

        // Finalize PDF
        doc.end();

        writeStream.on('finish', () => {
          const stats = fs.statSync(filepath);
          this.logger.log(`PDF generated: ${filename} (${stats.size} bytes)`);

          resolve({
            filename,
            filepath,
            size: stats.size,
          });
        });

        writeStream.on('error', reject);
      } catch (error) {
        this.logger.error('Error generating PDF:', error);
        reject(error);
      }
    });
  }

  private async insertImagesInContent(
    doc: PDFKit.PDFDocument,
    content: string,
    chapterImages: any[],
  ): Promise<void> {
    // Split content into sections based on number of images
    const paragraphs = content.split('\n\n').filter((p) => p.trim());
    const sectionsPerImage = Math.floor(
      paragraphs.length / (chapterImages.length + 1),
    );

    let currentParagraphIndex = 0;

    for (let i = 0; i < chapterImages.length; i++) {
      const image = chapterImages[i];

      // Add text before image
      const textSection = paragraphs
        .slice(currentParagraphIndex, currentParagraphIndex + sectionsPerImage)
        .join('\n\n');

      if (textSection) {
        doc.fontSize(11).font('Helvetica').text(textSection, {
          align: 'justify',
          lineGap: 5,
        });
        doc.moveDown(1);
      }

      // Insert image
      try {
        await this.insertImage(doc, image);
        doc.moveDown(1);
      } catch (error) {
        this.logger.error(`Failed to insert image ${image.filename}:`, error);
      }

      currentParagraphIndex += sectionsPerImage;
    }

    // Add remaining text after last image
    const remainingText = paragraphs.slice(currentParagraphIndex).join('\n\n');

    if (remainingText) {
      doc.fontSize(11).font('Helvetica').text(remainingText, {
        align: 'justify',
        lineGap: 5,
      });
    }
  }

  private async insertImage(
    doc: PDFKit.PDFDocument,
    image: any,
  ): Promise<void> {
    try {
      // Download image from Cloudinary URL
      const response = await axios.get(image.url, {
        responseType: 'arraybuffer',
      });
      const imageBuffer = Buffer.from(response.data, 'binary');

      // Calculate dimensions to fit in content area
      // Content width: 432 - 72 (margins) = 360 points (5 inches)
      const maxWidth = 360;
      const maxHeight = 250;

      doc.image(imageBuffer, {
        fit: [maxWidth, maxHeight],
        align: 'center',
      });

      // Add caption if exists
      if (image.caption) {
        doc.moveDown(0.5);
        doc.fontSize(9).font('Helvetica-Oblique').text(image.caption, {
          align: 'center',
        });
        doc.font('Helvetica'); // Reset font
      }
    } catch (error) {
      this.logger.error(`Error inserting image:`, error);
      throw error;
    }
  }

  private async insertFullPageImage(
    doc: PDFKit.PDFDocument,
    mapImage: any,
  ): Promise<void> {
    try {
      // Download map image
      const response = await axios.get(mapImage.url, {
        responseType: 'arraybuffer',
      });
      const imageBuffer = Buffer.from(response.data, 'binary');

      // Full page: 432x648 points (6x9 inches)
      // With small margins for safety
      doc.image(imageBuffer, 18, 18, {
        fit: [396, 612], // Slightly smaller than full page
        align: 'center',
        valign: 'center',
      });

      // Add caption at bottom if exists
      if (mapImage.caption) {
        doc.fontSize(10).font('Helvetica').text(mapImage.caption, 36, 600, {
          align: 'center',
        });
      }
    } catch (error) {
      this.logger.error(`Error inserting map image:`, error);
      throw error;
    }
  }

  private formatContentForPDF(content: string): string {
    return content
      .replace(/\n\n\n+/g, '\n\n')
      .replace(/\t/g, '    ')
      .trim();
  }

  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[^a-z0-9]/gi, '_')
      .replace(/_+/g, '_')
      .toLowerCase();
  }

  async deletePDF(filepath: string): Promise<void> {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      this.logger.log(`PDF deleted: ${filepath}`);
    }
  }
}
