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
          autoFirstPage: false, // We'll manage pages manually for numbering
        });

        const writeStream = fs.createWriteStream(filepath);
        doc.pipe(writeStream);

        let pageNumber = 0;

        // Helper function to add a new page with page number
        const addPageWithNumber = (skipNumber = false) => {
          doc.addPage();
          pageNumber++;

          if (!skipNumber && pageNumber > 1) {
            // Skip numbering on title page
            this.addPageNumber(doc, pageNumber);
          }
        };

        // Title Page (no page number)
        addPageWithNumber(true);
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
        doc
          .fontSize(12)
          .text(`(Including a map at the Last Page)`, { align: 'center' });
        doc.moveDown(2);

        doc.fontSize(14).text(`By ${author}`, { align: 'center' });

        // Copyright Page
        const copyrightChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('copyright'),
        );
        if (copyrightChapter) {
          addPageWithNumber();
          doc.fontSize(10).font('Helvetica').text(copyrightChapter.content);
        }

        // About Book
        const aboutChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('about'),
        );
        if (aboutChapter) {
          addPageWithNumber();
          doc.fontSize(16).font('Helvetica-Bold').text('About This Book');
          doc.moveDown();
          doc
            .fontSize(11)
            .font('Helvetica')
            .text(aboutChapter.content, { align: 'justify' });
        }

        // Table of Contents
        const tocChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('table'),
        );
        if (tocChapter) {
          addPageWithNumber();
          doc.fontSize(20).font('Helvetica-Bold').text('Table of Contents');
          doc.moveDown();
          doc.fontSize(11).font('Helvetica').text(tocChapter.content);
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
          const chapterNumber = chapter.order - 3;

          // Start each chapter on a new page
          if (i === 0) {
            addPageWithNumber();
          }

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
            const content = this.formatContentForPDF(chapter.content);
            doc.fontSize(11).font('Helvetica').text(content, {
              align: 'justify',
              lineGap: 5,
            });
          }

          // Add page break if not last chapter
          if (i < mainChapters.length - 1) {
            addPageWithNumber();
          }
        }

        // Add Map on Last Page (if exists)
        const mapImage = images.find((img) => img.isMap);
        if (mapImage) {
          addPageWithNumber();
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

  private addPageNumber(doc: PDFKit.PDFDocument, pageNumber: number): void {
    // Add page number at bottom center
    doc
      .fontSize(9)
      .font('Helvetica')
      .text(
        pageNumber.toString(),
        0,
        doc.page.height - 30, // 30 points from bottom
        {
          align: 'center',
          width: doc.page.width,
        },
      );
  }

  private async insertImagesInContent(
    doc: PDFKit.PDFDocument,
    content: string,
    chapterImages: any[],
  ): Promise<void> {
    const paragraphs = content.split('\n\n').filter((p) => p.trim());
    const sectionsPerImage = Math.floor(
      paragraphs.length / (chapterImages.length + 1),
    );

    let currentParagraphIndex = 0;

    for (let i = 0; i < chapterImages.length; i++) {
      const image = chapterImages[i];

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

      try {
        await this.insertImage(doc, image);
        doc.moveDown(1);
      } catch (error) {
        this.logger.error(`Failed to insert image ${image.filename}:`, error);
      }

      currentParagraphIndex += sectionsPerImage;
    }

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
      const response = await axios.get(image.url, {
        responseType: 'arraybuffer',
      });
      const imageBuffer = Buffer.from(response.data, 'binary');

      const maxWidth = 360;
      const maxHeight = 250;

      doc.image(imageBuffer, {
        fit: [maxWidth, maxHeight],
        align: 'center',
      });

      if (image.caption) {
        doc.moveDown(0.5);
        doc.fontSize(9).font('Helvetica-Oblique').text(image.caption, {
          align: 'center',
        });
        doc.font('Helvetica');
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
      const response = await axios.get(mapImage.url, {
        responseType: 'arraybuffer',
      });
      const imageBuffer = Buffer.from(response.data, 'binary');

      doc.image(imageBuffer, 18, 18, {
        fit: [396, 612],
        align: 'center',
        valign: 'center',
      });

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
