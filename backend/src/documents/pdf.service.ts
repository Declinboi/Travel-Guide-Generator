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
      let hasEnded = false;

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

        for (let i = 0; i < mainChapters.length; i++) {
          const chapter = mainChapters[i];
          const chapterNumber = chapter.order - 3;

          doc.addPage();

          // Add chapter number and title
          this.addChapterTitle(doc, chapter.title, chapterNumber);

          const chapterImages = images
            .filter((img) => img.chapterNumber === chapterNumber && !img.isMap)
            .sort((a, b) => (a.position || 0) - (b.position || 0));

          if (chapterImages.length > 0) {
            await this.addContentWithImages(
              doc,
              chapter.content,
              chapterImages,
              redisCache,
              title,
              subtitle,
            );
          } else {
            this.addFormattedContent(doc, chapter.content, title, subtitle);
          }

          if (global.gc && i % 2 === 0) {
            global.gc();
          }
        }

        // Add Map
        const mapImage = images.find((img) => img.isMap);
        if (mapImage) {
          // Check if we need a new page for the map
          const mapHeight = 421.2;
          const titleHeight = 50;
          const totalMapSpace = mapHeight + titleHeight + 100; // Extra padding

          if (
            doc.y + totalMapSpace >
            doc.page.height - doc.page.margins.bottom
          ) {
            doc.addPage();
          }

          await this.addMapPage(doc, mapImage, redisCache);
        }

        // Add page numbers to ALL pages
        const range = doc.bufferedPageRange();
        const totalPages = range.count;

        for (let i = 0; i < totalPages; i++) {
          doc.switchToPage(i);
          this.addPageNumber(doc, i + 1);
        }

        // CRITICAL FIX: Finalize the document
        this.logger.log('Finalizing PDF document...');
        hasEnded = true;
        doc.end();
      } catch (error) {
        this.logger.error('Error generating PDF:', error);

        if (doc && !hasEnded) {
          try {
            this.logger.log('Attempting to end document after error...');
            doc.end();
          } catch (e) {
            this.logger.error('Failed to end document:', e);
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
      .fontSize(10)
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
    doc.moveDown(1);

    const cleanedContent = this.cleanContent(content);
    const paragraphs = cleanedContent.split('\n\n').filter((p) => p.trim());

    paragraphs.forEach((para, index) => {
      const trimmed = para.trim();

      // Skip if it's the "About Book" heading
      if (
        trimmed.toLowerCase().includes('about this book') &&
        trimmed.length < 30
      ) {
        return;
      }

      doc
        .fontSize(11)
        .font('Helvetica')
        .text(trimmed, {
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
    const pageWidth = doc.page.width;
    const leftMargin = 50;
    const contentWidth = pageWidth - 100;

    // Title
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text('Table of Contents', leftMargin, 50, {
        width: contentWidth,
        align: 'center',
      });

    doc.moveDown(1);

    const cleanedContent = this.cleanContent(content);
    const lines = cleanedContent.split('\n').filter((l) => l.trim());

    lines.forEach((line, index) => {
      const trimmed = line.trim();

      // Skip the heading itself
      if (
        trimmed.toLowerCase().includes('table of contents') &&
        trimmed.length < 30
      ) {
        return;
      }

      if (!trimmed) {
        doc.moveDown(0.5);
        return;
      }

      // Chapter headings (e.g., "Chapter 1")
      if (trimmed.match(/^Chapter \d+$/i)) {
        doc.moveDown(0.8);
        doc
          .fontSize(12)
          .font('Helvetica-Bold')
          .fillColor('#2C3E50')
          .text(trimmed, leftMargin, doc.y, {
            continued: false,
          });
        doc.fillColor('#000000'); // Reset color
        doc.moveDown(0.3);
        return;
      }

      // Main chapter titles (not indented)
      if (!trimmed.startsWith(' ') && trimmed.length > 0) {
        const indent = leftMargin + 20;
        doc
          .fontSize(11)
          .font('Helvetica')
          .text(trimmed, indent, doc.y, {
            continued: false,
            width: contentWidth - 20,
          });
        doc.moveDown(0.4);
        return;
      }

      // Sub-sections (single indent)
      if (trimmed.match(/^\s{1,4}\S/)) {
        const indent = leftMargin + 40;
        doc
          .fontSize(10)
          .font('Helvetica')
          .fillColor('#34495E')
          .text(trimmed.trim(), indent, doc.y, {
            continued: false,
            width: contentWidth - 40,
          });
        doc.fillColor('#000000'); // Reset color
        doc.moveDown(0.3);
        return;
      }

      // Sub-sub-sections (double indent)
      const indent = leftMargin + 60;
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#7F8C8D')
        .text(trimmed.trim(), indent, doc.y, {
          continued: false,
          width: contentWidth - 60,
        });
      doc.fillColor('#000000'); // Reset color
      doc.moveDown(0.25);
    });
  }

  private addChapterTitle(
    doc: PDFKit.PDFDocument,
    title: string,
    chapterNumber: number,
  ): void {
    const cleanTitle = this.cleanText(title);

    doc.fontSize(20).font('Helvetica-Bold').text(`Chapter ${chapterNumber}`, {
      align: 'center',
    });
    doc.moveDown(1);

    doc.fontSize(20).font('Helvetica-Bold').text(cleanTitle, {
      align: 'center',
    });
    doc.moveDown(3);
  }

  private addFormattedContent(
    doc: PDFKit.PDFDocument,
    content: string,
    bookTitle?: string,
    bookSubtitle?: string,
  ): void {
    const cleanedContent = this.cleanContent(content);
    const sections = cleanedContent.split('\n\n').filter((p) => p.trim());

    sections.forEach((section, index) => {
      const trimmed = section.trim();
      const lowerTrimmed = trimmed.toLowerCase();

      // Skip chapter titles that are already added
      if (trimmed.match(/^Chapter \d+$/i)) {
        return;
      }

      // Skip chapter title text that matches the header
      if (
        trimmed.length < 100 &&
        trimmed.toLowerCase().startsWith('chapter ') &&
        trimmed.split(' ').length <= 15
      ) {
        return;
      }

      // Skip book title if it appears in content
      if (bookTitle && lowerTrimmed === bookTitle.toLowerCase()) {
        return;
      }

      // Skip book subtitle if it appears in content
      if (bookSubtitle && lowerTrimmed === bookSubtitle.toLowerCase()) {
        return;
      }

      // Skip if it looks like title/subtitle (short, all caps or title case, no period)
      if (
        trimmed.length < 150 &&
        !trimmed.includes('.') &&
        trimmed.split(' ').length <= 15 &&
        (trimmed === trimmed.toUpperCase() || this.isTitleCase(trimmed))
      ) {
        // Check if it closely matches title or subtitle
        if (
          bookTitle &&
          this.similarText(lowerTrimmed, bookTitle.toLowerCase())
        ) {
          return;
        }
        if (
          bookSubtitle &&
          this.similarText(lowerTrimmed, bookSubtitle.toLowerCase())
        ) {
          return;
        }
      }

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

  // Helper method to check if text is in Title Case
  private isTitleCase(text: string): boolean {
    const words = text.split(' ');
    return words.every((word) => {
      if (word.length === 0) return true;
      // Allow some lowercase words (a, an, the, of, in, etc.)
      const lowercaseWords = [
        'a',
        'an',
        'the',
        'of',
        'in',
        'on',
        'at',
        'to',
        'for',
        'and',
        'or',
        'but',
      ];
      if (lowercaseWords.includes(word.toLowerCase())) return true;
      // First letter should be uppercase
      return word[0] === word[0].toUpperCase();
    });
  }

  // Helper method to check if two strings are similar (handles minor variations)
  private similarText(str1: string, str2: string): boolean {
    // Remove special characters and extra spaces
    const clean1 = str1
      .replace(/[^a-z0-9\s]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const clean2 = str2
      .replace(/[^a-z0-9\s]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    return (
      clean1 === clean2 || clean1.includes(clean2) || clean2.includes(clean1)
    );
  }

  private addCopyrightPage(doc: PDFKit.PDFDocument, content: string): void {
    const cleanedContent = this.cleanContent(content);

    doc
      .fontSize(11)
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
    redisCache: RedisCacheService,
    bookTitle?: string,
    bookSubtitle?: string,
  ): Promise<void> {
    const paragraphs = content.split('\n\n').filter((p) => p.trim());

    const sections = this.createContentSections(
      paragraphs,
      chapterImages.length,
    );

    for (const section of sections) {
      if (section.paragraphs.length > 0) {
        this.addFormattedContent(
          doc,
          section.paragraphs.join('\n\n'),
          bookTitle,
          bookSubtitle,
        ); // UPDATE THIS
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

          await this.insertImage(doc, image, redisCache);

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

    const minParagraphsBeforeImage = 1;
    const minParagraphsAfterImage = 1;
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
      doc.moveDown(1);

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
    const pageHeight = doc.page.height;
    const pageWidth = doc.page.width;
    const bottomMargin = doc.page.margins.bottom;

    // Save current state
    doc.save();

    // Position at bottom center
    const y = pageHeight - bottomMargin + 20; // 20 points above bottom margin

    doc.fontSize(10).font('Helvetica').fillColor('#000000').text(
      pageNumber.toString(),
      0, // Start from left edge
      y,
      {
        align: 'center',
        width: pageWidth, // Full page width for centering
      },
    );

    // Restore state
    doc.restore();
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
