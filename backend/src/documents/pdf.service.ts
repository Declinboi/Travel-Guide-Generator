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
      let doc: PDFKit.PDFDocument | null = null;
      let writeStream: fs.WriteStream | null = null;

      try {
        this.logMemory('PDF Start');

        const filename = `${this.sanitizeFilename(title)}_${Date.now()}.pdf`;
        const filepath = path.join(this.storagePath, filename);

        doc = new PDFDocument({
          size: [432, 648], // 6x9 inches
          margins: { top: 50, bottom: 50, left: 50, right: 50 },
          info: {
            Title: title,
            Author: author,
          },
          autoFirstPage: false,
          bufferPages: true, // Enable buffering for page numbers
          compress: true,
        });

        writeStream = fs.createWriteStream(filepath);
        doc.pipe(writeStream);

        let actualPageNumber = 0; // For content pages only
        let totalPages = 0;

        // FRONT MATTER (no page numbers)
        
        // 1. Title Page
        doc.addPage();
        this.addTitlePage(doc, title, subtitle, author);

        // 2. Blank page
        doc.addPage();

        // 3. Another blank page
        doc.addPage();

        // 4. Copyright Page
        const copyrightChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('copyright'),
        );
        if (copyrightChapter) {
          doc.addPage();
          this.addCopyrightPage(doc, copyrightChapter.content);
        }

        // 5. About Book
        const aboutChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('about'),
        );
        if (aboutChapter) {
          doc.addPage();
          this.addAboutPage(doc, aboutChapter.content);
        }

        // 6. Table of Contents
        const tocChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('table'),
        );
        if (tocChapter) {
          doc.addPage();
          this.addTableOfContents(doc, tocChapter.content);
        }

        // MAIN CONTENT (with page numbers)
        const mainChapters = chapters
          .filter(
            (c) =>
              !['title', 'copyright', 'about', 'table'].some((keyword) =>
                c.title.toLowerCase().includes(keyword),
              ),
          )
          .sort((a, b) => a.order - b.order);

        // Start page numbering from first main chapter
        actualPageNumber = 1;

        for (let i = 0; i < mainChapters.length; i++) {
          const chapter = mainChapters[i];
          const chapterNumber = chapter.order - 3;

          doc.addPage();
          actualPageNumber++;

          // Add chapter title
          this.addChapterTitle(doc, chapter.title, chapterNumber);

          // Get chapter images
          const chapterImages = images
            .filter((img) => img.chapterNumber === chapterNumber && !img.isMap)
            .sort((a, b) => (a.position || 0) - (b.position || 0));

          if (chapterImages.length > 0) {
            await this.addContentWithImages(doc, chapter.content, chapterImages);
          } else {
            this.addFormattedContent(doc, chapter.content);
          }

          // Force GC after each chapter
          if (global.gc && i % 2 === 0) {
            global.gc();
          }
        }

        // Add Map on Last Page
        const mapImage = images.find((img) => img.isMap);
        if (mapImage) {
          doc.addPage();
          actualPageNumber++;
          await this.addMapPage(doc, mapImage);
        }

        // Add page numbers to all content pages
        const range = doc.bufferedPageRange();
        const startPage = 7; // Pages after TOC
        
        for (let i = startPage; i < range.count; i++) {
          doc.switchToPage(i);
          const pageNum = i - startPage + 1;
          this.addPageNumber(doc, pageNum);
        }

        doc.end();

        writeStream.on('finish', () => {
          const stats = fs.statSync(filepath);
          this.logger.log(`PDF generated: ${filename} (${stats.size} bytes)`);
          this.logMemory('PDF Complete');

          doc = null;
          writeStream = null;

          resolve({
            filename,
            filepath,
            size: stats.size,
          });
        });

        writeStream.on('error', (err) => {
          this.logger.error('Write stream error:', err);
          doc = null;
          writeStream = null;
          reject(err);
        });
      } catch (error) {
        this.logger.error('Error generating PDF:', error);

        if (doc) {
          try {
            doc.end();
          } catch (e) {
            // Ignore cleanup errors
          }
        }

        doc = null;
        writeStream = null;

        reject(error);
      }
    });
  }

  private addTitlePage(
    doc: PDFKit.PDFDocument,
    title: string,
    subtitle: string,
    author: string,
  ): void {
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;

    // Title - centered and large
    doc.fontSize(32)
      .font('Helvetica-Bold')
      .text(title.toUpperCase(), 50, 100, {
        width: pageWidth - 100,
        align: 'center',
      });

    // Subtitle
    if (subtitle) {
      doc.fontSize(18)
        .font('Helvetica')
        .text(subtitle, 50, 180, {
          width: pageWidth - 100,
          align: 'center',
        });
    }

    // Year/Version info
    doc.fontSize(14)
      .font('Helvetica')
      .text('2026', 50, 240, {
        width: pageWidth - 100,
        align: 'center',
      });

    // Note about map
    doc.fontSize(11)
      .font('Helvetica-Oblique')
      .text('(Including a map at the Last Page)', 50, 280, {
        width: pageWidth - 100,
        align: 'center',
      });

    // Author at bottom third
    doc.fontSize(12)
      .font('Helvetica')
      .text('A practical roadmap with step-by-step plans for', 50, 380, {
        width: pageWidth - 100,
        align: 'center',
      });

    doc.fontSize(12)
      .font('Helvetica')
      .text('every kind of traveler', 50, 400, {
        width: pageWidth - 100,
        align: 'center',
      });

    doc.fontSize(16)
      .font('Helvetica-Bold')
      .text('By', 50, 480, {
        width: pageWidth - 100,
        align: 'center',
      });

    doc.fontSize(16)
      .font('Helvetica-Bold')
      .text(author.toUpperCase(), 50, 510, {
        width: pageWidth - 100,
        align: 'center',
      });
  }

  private addCopyrightPage(doc: PDFKit.PDFDocument, content: string): void {
    doc.fontSize(9)
      .font('Helvetica')
      .text(content, 50, 100, {
        width: doc.page.width - 100,
        align: 'left',
        lineGap: 4,
      });
  }

  private addAboutPage(doc: PDFKit.PDFDocument, content: string): void {
    doc.fontSize(16)
      .font('Helvetica-Bold')
      .text('About Book', 50, 50);

    doc.moveDown(1.5);

    const paragraphs = content.split('\n\n').filter(p => p.trim());
    
    paragraphs.forEach((para, index) => {
      doc.fontSize(11)
        .font('Helvetica')
        .text(para.trim(), {
          width: doc.page.width - 100,
          align: 'left',
          lineGap: 5,
        });
      
      if (index < paragraphs.length - 1) {
        doc.moveDown(1);
      }
    });
  }

  private addTableOfContents(doc: PDFKit.PDFDocument, content: string): void {
    doc.fontSize(16)
      .font('Helvetica-Bold')
      .text('Table of Contents', 50, 50);

    doc.moveDown(1.5);

    const lines = content.split('\n').filter(l => l.trim());
    
    lines.forEach(line => {
      const trimmed = line.trim();
      
      if (!trimmed) {
        doc.moveDown(0.3);
        return;
      }

      // Chapter headers (no indentation)
      if (trimmed.match(/^Chapter \d+$/)) {
        doc.moveDown(0.5);
        doc.fontSize(11)
          .font('Helvetica-Bold')
          .text(trimmed, {
            continued: false,
          });
      }
      // Chapter titles (no indentation)
      else if (!trimmed.startsWith(' ')) {
        doc.fontSize(11)
          .font('Helvetica')
          .text(trimmed, {
            continued: false,
          });
      }
      // Sections (slight indent)
      else if (trimmed.match(/^[A-Z]/)) {
        doc.fontSize(10)
          .font('Helvetica')
          .text(trimmed.trim(), 65, doc.y, {
            continued: false,
          });
      }
      // Subsections (more indent)
      else {
        doc.fontSize(9)
          .font('Helvetica')
          .text(trimmed.trim(), 80, doc.y, {
            continued: false,
          });
      }
    });
  }

  private addChapterTitle(
    doc: PDFKit.PDFDocument,
    title: string,
    chapterNumber: number,
  ): void {
    // Chapter number
    doc.fontSize(14)
      .font('Helvetica')
      .text(`Chapter ${chapterNumber}`, {
        align: 'left',
      });

    doc.moveDown(0.5);

    // Chapter title
    doc.fontSize(18)
      .font('Helvetica-Bold')
      .text(title, {
        align: 'left',
      });

    doc.moveDown(2);
  }

  private addFormattedContent(doc: PDFKit.PDFDocument, content: string): void {
    const sections = content.split('\n\n').filter(p => p.trim());
    
    sections.forEach((section, index) => {
      const trimmed = section.trim();
      
      // Section headers (typically bold in original)
      if (trimmed.length < 100 && !trimmed.includes('.')) {
        doc.fontSize(13)
          .font('Helvetica-Bold')
          .text(trimmed, {
            align: 'left',
            lineGap: 5,
          });
        doc.moveDown(0.8);
      }
      // Regular paragraphs
      else {
        doc.fontSize(11)
          .font('Helvetica')
          .text(trimmed, {
            align: 'left',
            lineGap: 5,
          });
        
        if (index < sections.length - 1) {
          doc.moveDown(1);
        }
      }
    });
  }

  private async addContentWithImages(
    doc: PDFKit.PDFDocument,
    content: string,
    chapterImages: any[],
  ): Promise<void> {
    const paragraphs = content.split('\n\n').filter((p) => p.trim());
    const sectionsPerImage = Math.floor(
      paragraphs.length / (chapterImages.length + 1),
    );

    let currentIndex = 0;

    for (let i = 0; i < chapterImages.length; i++) {
      const image = chapterImages[i];

      const textSection = paragraphs
        .slice(currentIndex, currentIndex + sectionsPerImage)
        .join('\n\n');

      if (textSection) {
        this.addFormattedContent(doc, textSection);
        doc.moveDown(1);
      }

      try {
        await this.insertImage(doc, image);
        doc.moveDown(1.5);
      } catch (error) {
        this.logger.error(`Failed to insert image ${image.filename}:`, error);
      }

      currentIndex += sectionsPerImage;
    }

    const remainingText = paragraphs.slice(currentIndex).join('\n\n');

    if (remainingText) {
      this.addFormattedContent(doc, remainingText);
    }
  }

  private async insertImage(
    doc: PDFKit.PDFDocument,
    image: any,
  ): Promise<void> {
    let imageBuffer: Buffer | null = null;

    try {
      const response = await axios.get(image.url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024,
      });

      imageBuffer = Buffer.from(response.data, 'binary');

      // Image dimensions: 3.98 inches width x 2.53 inches height
      // At 72 DPI: width = 286.56pt, height = 182.16pt
      const imageWidth = 286.56;
      const imageHeight = 182.16;

      const xPosition = (doc.page.width - imageWidth) / 2;

      doc.image(imageBuffer, xPosition, doc.y, {
        width: imageWidth,
        height: imageHeight,
        align: 'center',
      });

      doc.moveDown(0.5);

      if (image.caption) {
        doc.fontSize(9)
          .font('Helvetica-Oblique')
          .text(image.caption, {
            align: 'center',
            width: doc.page.width - 100,
          });
        doc.font('Helvetica');
      }
    } catch (error) {
      this.logger.error(`Error inserting image:`, error);
      throw error;
    } finally {
      imageBuffer = null;
      if (global.gc) {
        global.gc();
      }
    }
  }

  private async addMapPage(
    doc: PDFKit.PDFDocument,
    mapImage: any,
  ): Promise<void> {
    let imageBuffer: Buffer | null = null;

    try {
      doc.fontSize(16)
        .font('Helvetica-Bold')
        .text('Geographical Map of Trieste', {
          align: 'center',
        });

      doc.moveDown(2);

      const response = await axios.get(mapImage.url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024,
      });

      imageBuffer = Buffer.from(response.data, 'binary');

      // Map dimensions: 3.97 inches width x 5.85 inches height
      // At 72 DPI: width = 285.84pt, height = 421.2pt
      const mapWidth = 285.84;
      const mapHeight = 421.2;
      const xPosition = (doc.page.width - mapWidth) / 2;

      doc.image(imageBuffer, xPosition, doc.y, {
        width: mapWidth,
        height: mapHeight,
        align: 'center',
      });
    } catch (error) {
      this.logger.error(`Error inserting map image:`, error);
      throw error;
    } finally {
      imageBuffer = null;
      if (global.gc) {
        global.gc();
      }
    }
  }

  private addPageNumber(doc: PDFKit.PDFDocument, pageNumber: number): void {
    doc.fontSize(10)
      .font('Helvetica')
      .text(pageNumber.toString(), 50, doc.page.height - 30, {
        align: 'center',
        width: doc.page.width - 100,
      });
  }

  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[^a-z0-9]/gi, '_')
      .replace(/_+/g, '_')
      .toLowerCase();
  }

  private logMemory(label: string): void {
    const used = process.memoryUsage();
    this.logger.log(
      `[${label}] Heap: ${Math.round(used.heapUsed / 1024 / 1024)} MB | RSS: ${Math.round(used.rss / 1024 / 1024)} MB`,
    );
  }

  async deletePDF(filepath: string): Promise<void> {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      this.logger.log(`PDF deleted: ${filepath}`);
    }
  }
}