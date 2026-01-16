// src/modules/document/pdf.service.ts
import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import axios from 'axios';
import { RedisCacheService } from 'src/queues/queues.module';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  constructor(private configService: ConfigService) {}
  /**
   * Generate PDF and return as Buffer (for Cloudinary upload)
   */
  async generatePDFBuffer(
    title: string,
    subtitle: string,
    author: string,
    chapters: any[],
    images: any[] = [],
    redisCache: RedisCacheService,
  ): Promise<{ buffer: Buffer; filename: string }> {
    return new Promise(async (resolve, reject) => {
      let doc: PDFKit.PDFDocument | null = null;
      const chunks: Buffer[] = [];

      try {
        this.logMemory('PDF Start');

        const filename = `${this.sanitizeFilename(title)}_${Date.now()}.pdf`;

        doc = new PDFDocument({
          size: [432, 648],
          margins: {
            top: 79.2,
            bottom: 79.2,
            left: 72,
            right: 72,
          },
          info: {
            Title: title,
            Author: author,
          },
          autoFirstPage: false,
          bufferPages: true,
          compress: true,
        });

        // Collect buffer chunks
        doc.on('data', (chunk) => chunks.push(chunk));

        doc.on('end', () => {
          const buffer = Buffer.concat(chunks);
          this.logger.log(
            `PDF generated: ${filename} (${buffer.length} bytes)`,
          );
          this.logMemory('PDF Complete');

          doc = null;
          chunks.length = 0;

          resolve({ buffer, filename });
        });

        doc.on('error', (err) => {
          this.logger.error('PDF generation error:', err);
          doc = null;
          chunks.length = 0;
          reject(err);
        });

        let actualPageNumber = 0;

        // FRONT MATTER
        doc.addPage();
        this.addTitlePage(doc, title, subtitle, author);

        const copyrightChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('copyright'),
        );
        if (copyrightChapter) {
          doc.addPage();
          this.addCopyrightPage(doc, copyrightChapter.content);
        }

        const aboutChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('about'),
        );
        if (aboutChapter) {
          doc.addPage();
          this.addAboutPage(doc, aboutChapter.content);
        }

        const tocChapter = chapters.find((c) =>
          c.title.toLowerCase().includes('table'),
        );
        if (tocChapter) {
          doc.addPage();
          this.addTableOfContents(doc, tocChapter.content);
        }

        // MAIN CONTENT
        const mainChapters = chapters
          .filter(
            (c) =>
              !['title', 'copyright', 'about', 'table'].some((keyword) =>
                c.title.toLowerCase().includes(keyword),
              ),
          )
          .sort((a, b) => a.order - b.order);

        actualPageNumber = 1;

        for (let i = 0; i < mainChapters.length; i++) {
          const chapter = mainChapters[i];
          const chapterNumber = chapter.order - 3;

          doc.addPage();
          actualPageNumber++;

          this.addChapterTitle(doc, chapter.title, chapterNumber);

          const chapterImages = images
            .filter((img) => img.chapterNumber === chapterNumber && !img.isMap)
            .sort((a, b) => (a.position || 0) - (b.position || 0));

          if (chapterImages.length > 0) {
            await this.addContentWithImages(
              doc,
              chapter.content,
              chapterImages,
              redisCache, // PASS cache
            );
          } else {
            this.addFormattedContent(doc, chapter.content);
          }

          if (global.gc && i % 2 === 0) {
            global.gc();
          }
        }

        // Add Map
        const mapImage = images.find((img) => img.isMap);
        if (mapImage) {
          doc.addPage();
          actualPageNumber++;
          await this.addMapPage(doc, mapImage, redisCache); // PASS cache
        }

        // Add page numbers
        const range = doc.bufferedPageRange();
        const startPage = 7;

        for (let i = startPage; i < range.count; i++) {
          doc.switchToPage(i);
          const pageNum = i - startPage + 1;
          this.addPageNumber(doc, pageNum);
        }

        doc.end();
      } catch (error) {
        this.logger.error('Error generating PDF:', error);

        if (doc) {
          try {
            doc.end();
          } catch (e) {
            // Ignore
          }
        }

        doc = null;
        chunks.length = 0;

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
    doc
      .fontSize(32)
      .font('Helvetica-Bold')
      .text(title.toUpperCase(), 50, 100, {
        width: pageWidth - 100,
        align: 'center',
      });

    if (subtitle) {
      doc
        .fontSize(18)
        .font('Helvetica')
        .text(subtitle, 50, 180, {
          width: pageWidth - 100,
          align: 'center',
        });
    }

    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .text('By', 50, 480, {
        width: pageWidth - 100,
        align: 'center',
      });

    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .text(author.toUpperCase(), 50, 510, {
        width: pageWidth - 100,
        align: 'center',
      });
  }

  private addAboutPage(doc: PDFKit.PDFDocument, content: string): void {
    doc.fontSize(16).font('Helvetica-Bold').text('About Book', 50, 50);
    doc.moveDown(1.5);

    const cleanedContent = this.cleanContent(content);
    const paragraphs = cleanedContent.split('\n\n').filter((p) => p.trim());

    paragraphs.forEach((para, index) => {
      doc
        .fontSize(11)
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
    doc.fontSize(16).font('Helvetica-Bold').text('Table of Contents', 50, 50);
    doc.moveDown(1.5);

    const cleanedContent = this.cleanContent(content);
    const lines = cleanedContent.split('\n').filter((l) => l.trim());

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        doc.moveDown(0.3);
        return;
      }

      if (trimmed.match(/^Chapter \d+$/)) {
        doc.moveDown(0.5);
        doc.fontSize(11).font('Helvetica-Bold').text(trimmed, {
          continued: false,
        });
      } else if (!trimmed.startsWith(' ')) {
        doc.fontSize(11).font('Helvetica').text(trimmed, {
          continued: false,
        });
      } else if (trimmed.match(/^[A-Z]/)) {
        doc.fontSize(10).font('Helvetica').text(trimmed.trim(), 65, doc.y, {
          continued: false,
        });
      } else {
        doc.fontSize(9).font('Helvetica').text(trimmed.trim(), 80, doc.y, {
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
    const cleanTitle = this.cleanText(title);

    doc.fontSize(16).font('Helvetica').text(`Chapter ${chapterNumber}`, {
      align: 'center',
    });
    doc.moveDown(1.5);

    doc.fontSize(20).font('Helvetica-Bold').text(cleanTitle, {
      align: 'center',
    });
    doc.moveDown(3);
  }

  private addFormattedContent(doc: PDFKit.PDFDocument, content: string): void {
    const cleanedContent = this.cleanContent(content);
    const sections = cleanedContent.split('\n\n').filter((p) => p.trim());

    sections.forEach((section, index) => {
      const trimmed = section.trim();

      const isHeader =
        trimmed.length < 100 &&
        !trimmed.includes('.') &&
        trimmed.split(' ').length <= 10;

      if (isHeader) {
        doc.fontSize(14).font('Helvetica-Bold').text(trimmed, {
          align: 'left',
          lineGap: 5,
        });
        doc.moveDown(1.2);
      } else {
        doc.fontSize(11).font('Helvetica').text(trimmed, {
          align: 'left',
          lineGap: 5,
        });

        if (index < sections.length - 1) {
          doc.moveDown(1);
        }
      }
    });
  }

  private addCopyrightPage(doc: PDFKit.PDFDocument, content: string): void {
    const cleanedContent = this.cleanContent(content);

    doc
      .fontSize(9)
      .font('Helvetica')
      .text(cleanedContent, 50, 100, {
        width: doc.page.width - 100,
        align: 'left',
        lineGap: 4,
      });
  }

  private async addContentWithImages(
    doc: PDFKit.PDFDocument,
    content: string,
    chapterImages: any[],
    redisCache: RedisCacheService, // ADDED: Optional image cache
  ): Promise<void> {
    const paragraphs = content.split('\n\n').filter((p) => p.trim());

    const sections = this.createContentSections(
      paragraphs,
      chapterImages.length,
    );

    for (const section of sections) {
      if (section.paragraphs.length > 0) {
        this.addFormattedContent(doc, section.paragraphs.join('\n\n'));
      }

      if (
        section.imageIndex !== undefined &&
        chapterImages[section.imageIndex]
      ) {
        const image = chapterImages[section.imageIndex];

        try {
          doc.moveDown(2.5);

          const imageHeight = 182.16;
          const totalSpaceNeeded = imageHeight + 80;

          if (
            doc.y + totalSpaceNeeded >
            doc.page.height - doc.page.margins.bottom
          ) {
            doc.addPage();
            doc.moveDown(1);
          }

          await this.insertImage(doc, image, redisCache); // PASS cache

          doc.moveDown(2.5);

          if (global.gc) {
            global.gc();
          }

          await this.delay(100);
        } catch (error) {
          this.logger.error(`Failed to insert image ${image.filename}:`, error);
        }
      }
    }
  }

  private createContentSections(
    paragraphs: string[],
    imageCount: number,
  ): Array<{ paragraphs: string[]; imageIndex?: number }> {
    const sections: Array<{ paragraphs: string[]; imageIndex?: number }> = [];

    if (imageCount === 0) {
      sections.push({ paragraphs });
      return sections;
    }

    const minParagraphsBeforeImage = 2;
    const minParagraphsAfterImage = 2;
    const usableSpace = paragraphs.length - minParagraphsAfterImage;

    if (usableSpace < minParagraphsBeforeImage) {
      sections.push({ paragraphs });
      return sections;
    }

    const spacing = Math.floor(usableSpace / (imageCount + 1));
    const placements: number[] = [];

    for (let i = 0; i < imageCount; i++) {
      const position = Math.min(
        minParagraphsBeforeImage + spacing * (i + 1),
        paragraphs.length - minParagraphsAfterImage - (imageCount - i - 1),
      );
      placements.push(position);
    }

    let lastIndex = 0;

    placements.forEach((position, idx) => {
      const sectionParagraphs = paragraphs.slice(lastIndex, position);

      sections.push({
        paragraphs: sectionParagraphs,
        imageIndex: idx,
      });

      lastIndex = position;
    });

    if (lastIndex < paragraphs.length) {
      sections.push({
        paragraphs: paragraphs.slice(lastIndex),
      });
    }

    return sections;
  }

  /**
   * CRITICAL FIX: Use cached image or download if not cached
   */
  private async insertImage(
    doc: PDFKit.PDFDocument,
    image: any,
    redisCache: RedisCacheService, // ADDED: Optional image cache
  ): Promise<void> {
    let imageBuffer: Buffer | null = null;

    try {
      // GET FROM REDIS
      imageBuffer = await redisCache.getImage(image.url);

      if (!imageBuffer) {
        // FALLBACK: Download if not in Redis
        this.logger.warn(
          `⚠ Image not in Redis, downloading: ${image.url.substring(image.url.lastIndexOf('/') + 1)}`,
        );
        imageBuffer = await this.downloadImageWithRetry(image.url);
      } else {
        this.logger.debug(
          `✓ Retrieved from Redis: ${image.url.substring(image.url.lastIndexOf('/') + 1)}`,
        );
      }

      const imageWidth = 286.56;
      const imageHeight = 182.16;
      const xPosition = (doc.page.width - imageWidth) / 2;

      const imageY = doc.y;

      const borderPadding = 4;
      doc.save();
      doc
        .rect(
          xPosition - borderPadding,
          imageY - borderPadding,
          imageWidth + borderPadding * 2,
          imageHeight + borderPadding * 2,
        )
        .lineWidth(0.5)
        .strokeColor('#DDDDDD')
        .stroke();
      doc.restore();

      doc.image(imageBuffer, xPosition, imageY, {
        width: imageWidth,
        height: imageHeight,
      });

      doc.y = imageY + imageHeight;
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
    redisCache: RedisCacheService,
  ): Promise<void> {
    let imageBuffer: Buffer | null = null;

    try {
      doc.fontSize(16).font('Helvetica-Bold').text('Geographical Map', {
        align: 'center',
      });
      doc.moveDown(2);

      // GET FROM REDIS
      imageBuffer = await redisCache.getImage(mapImage.url);

      if (!imageBuffer) {
        this.logger.warn(
          `⚠ Map not in Redis, downloading: ${mapImage.url.substring(mapImage.url.lastIndexOf('/') + 1)}`,
        );
        imageBuffer = await this.downloadImageWithRetry(mapImage.url);
      } else {
        this.logger.debug(
          `✓ Retrieved map from Redis: ${mapImage.url.substring(mapImage.url.lastIndexOf('/') + 1)}`,
        );
      }

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
    doc
      .fontSize(10)
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

  private cleanText(text: string): string {
    if (!text) return '';

    return text
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/_(.+?)_/g, '$1')
      .replace(/^#+\s+/gm, '')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private cleanContent(content: string): string {
    if (!content) return '';

    const paragraphs = content.split('\n\n');
    const cleanedParagraphs = paragraphs
      .map((para) => this.cleanText(para))
      .filter((para) => para.length > 0);

    return cleanedParagraphs.join('\n\n');
  }

  private async downloadImageWithRetry(
    url: string,
    maxRetries: number = 4,
    timeoutMs: number = 60000,
  ): Promise<Buffer> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.log(
          `[Attempt ${attempt}/${maxRetries}] Downloading image: ${url}`,
        );

        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: timeoutMs,
          maxContentLength: 10 * 1024 * 1024,
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TravelGuideGenerator/1.0)',
          },
          family: 4,
        });

        this.logger.log(`✓ Image downloaded successfully: ${url}`);
        return Buffer.from(response.data, 'binary');
      } catch (error) {
        lastError = error;

        if (axios.isAxiosError(error)) {
          const code = error.code || error.response?.status;
          this.logger.warn(
            `[Attempt ${attempt}/${maxRetries}] Failed to download image: ${code}`,
          );

          if (
            error.response?.status === 404 ||
            error.response?.status === 403
          ) {
            this.logger.error(`Image not found or forbidden: ${url}`);
            throw new Error(`Image not accessible: ${url}`);
          }
        }

        if (attempt < maxRetries) {
          const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          this.logger.log(`Waiting ${waitTime}ms before retry...`);
          await this.delay(waitTime);
        }
      }
    }

    this.logger.error(
      `Failed to download image after ${maxRetries} attempts: ${url}`,
    );
    throw lastError;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
