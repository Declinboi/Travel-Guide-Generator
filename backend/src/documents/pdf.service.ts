// src/modules/document/pdf.service.ts
import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import axios from 'axios';
import { RedisCacheService } from 'src/queues/queues.module';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  constructor(private configService: ConfigService) {}

  // Define font paths - place fonts in your project's assets/fonts folder
  private readonly FONTS = {
    title: {
      regular: path.join(
        process.cwd(),
        'assets/fonts/PlayfairDisplay-Regular.ttf',
      ),
      bold: path.join(process.cwd(), 'assets/fonts/PlayfairDisplay-Bold.ttf'),
      extrabold: path.join(
        process.cwd(),
        'assets/fonts/PlayfairDisplay-ExtraBold.ttf',
      ),
    },
    body: {
      regular: path.join(process.cwd(), 'assets/fonts/Lora-Regular.ttf'),
      bold: path.join(process.cwd(), 'assets/fonts/Lora-Bold.ttf'),
      italic: path.join(process.cwd(), 'assets/fonts/Lora-Italic.ttf'),
    },
  };

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
            bottom: 79.2, // 79.2
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

        // Register custom fonts
        try {
          doc.registerFont('TitleRegular', this.FONTS.title.regular);
          doc.registerFont('TitleBold', this.FONTS.title.bold);
          doc.registerFont('TitleExtraBold', this.FONTS.title.extrabold);
          doc.registerFont('BodyRegular', this.FONTS.body.regular);
          doc.registerFont('BodyBold', this.FONTS.body.bold);
          doc.registerFont('BodyItalic', this.FONTS.body.italic);
        } catch (fontError) {
          this.logger.warn('Custom fonts not found, falling back to Helvetica');
          // Will use default fonts if custom ones aren't available
        }

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
        // doc.addPage();
        this.addTitlePage(doc, title, subtitle, author);

        const copyrightChapter = chapters.find((c) =>
          this.isCopyrightChapter(c.title),
        );
        if (copyrightChapter) {
          doc.addPage();
          this.addCopyrightPage(doc, copyrightChapter.content);
        }

        const aboutChapter = chapters.find((c) => this.isAboutChapter(c.title));
        if (aboutChapter) {
          doc.addPage();
          this.addAboutPage(doc, aboutChapter.content);
        }

        const tocChapter = chapters.find((c) =>
          this.isTableOfContentsChapter(c.title),
        );
        if (tocChapter) {
          doc.addPage();
          this.addTableOfContents(doc, tocChapter.content);
        }

        // MAIN CONTENT
        const mainChapters = chapters
          .filter((c) => !this.isFrontMatterChapter(c.title))
          .sort((a, b) => a.order - b.order);

        for (let i = 0; i < mainChapters.length; i++) {
          const chapter = mainChapters[i];

          // Calculate proper chapter number (starting from 1)
          const chapterNumber = i + 1;

          doc.addPage();

          // Add chapter number and title for content chapters
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
          const mapHeight = 421.2;
          const titleHeight = 50;
          const totalMapSpace = mapHeight + titleHeight + 100;

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

  private isCopyrightChapter(title: string): boolean {
    const copyrightKeywords = [
      'copyright',
      'urheberrecht',
      "droit d'auteur",
      "diritto d'autore",
      'derechos de autor',
      'derechos',
    ];
    const lowerTitle = title.toLowerCase();
    return copyrightKeywords.some((keyword) => lowerTitle.includes(keyword));
  }

  private isAboutChapter(title: string): boolean {
    const aboutKeywords = [
      'about book',
      'about the',
      'über das buch',
      'über dieses buch',
      'à propos',
      'informazioni su book',
      'sul libro',
      'sobre el libro',
      'acerca del libro',
    ];
    const lowerTitle = title.toLowerCase();
    return aboutKeywords.some((keyword) => lowerTitle.includes(keyword));
  }

  private isTableOfContentsChapter(title: string): boolean {
    const tocKeywords = [
      'table of contents',
      'inhaltsverzeichnis',
      'table des matières',
      'sommaire',
      'tabella dei contenuti',
      'índice',
      'tabla de contenidos',
      'cuadro de contenidos',
    ];
    const lowerTitle = title.toLowerCase();
    return tocKeywords.some((keyword) => lowerTitle.includes(keyword));
  }

  // ✅ NEW: Helper to identify front matter
  private isFrontMatterChapter(title: string): boolean {
    const frontMatterTitles = [
      // English
      'title page',
      'copyright',
      'about book',
      'table of contents',
      // German
      'titelseite',
      'urheberrecht',
      'über das buch',
      'inhaltsverzeichnis',
      // French
      'titre page',
      'page de titre',
      "droit d'auteur",
      'à propos',
      'sommaire',
      'table des matières',
      // Italian
      'pagina titolo',
      "diritto d'autore",
      'informazioni su book',
      'tabella dei contenuti',
      'sommario',
      // Spanish (if needed)
      'página de título',
      'derechos de autor',
      'sobre el libro',
      'índice',
      'tabla de contenidos',
      'cuadro de contenidos',
      'acerca del libro',
      'derechos',
    ];

    const lowerTitle = title.toLowerCase();
    return frontMatterTitles.some((fm) => lowerTitle.includes(fm));
  }

  private addTitlePage(
    doc: PDFKit.PDFDocument,
    title: string,
    subtitle: string,
    author: string,
  ): void {
    doc.addPage();
    const pageWidth = doc.page.width;

    // ✅ FIXED: Directly try to use custom fonts with fallback
    try {
      doc.fontSize(30).font('TitleExtraBold');
    } catch (error) {
      doc.fontSize(30).font('Helvetica-Bold');
    }

    doc.text(title.toUpperCase(), 50, 100, {
      width: pageWidth - 100,
      align: 'center',
    });

    if (subtitle) {
      try {
        doc.fontSize(10).font('BodyRegular');
      } catch (error) {
        doc.fontSize(10).font('Helvetica');
      }

      doc.text(subtitle, 50, 220, {
        width: pageWidth - 100,
        align: 'center',
      });
    }

    try {
      doc.fontSize(10).font('BodyRegular');
    } catch (error) {
      doc.fontSize(10).font('Helvetica');
    }

    doc.text('By', 50, 480, {
      width: pageWidth - 100,
      align: 'center',
    });

    try {
      doc.fontSize(16).font('TitleBold');
    } catch (error) {
      doc.fontSize(16).font('Helvetica-Bold');
    }

    doc.text(author.toUpperCase(), 50, 510, {
      width: pageWidth - 100,
      align: 'center',
    });
  }

  private addAboutPage(doc: PDFKit.PDFDocument, content: string): void {
    const headerFont = this.getFontOrFallback(
      doc,
      'TitleBold',
      'Helvetica-Bold',
    );
    const bodyFont = this.getFontOrFallback(doc, 'BodyRegular', 'Helvetica');

    doc.fontSize(16).font(headerFont).text('About Book', 50, 50);
    doc.moveDown(1);

    const cleanedContent = this.cleanFrontMatterContent(content);
    const paragraphs = cleanedContent.split('\n\n').filter((p) => p.trim());

    paragraphs.forEach((para, index) => {
      doc
        .fontSize(11)
        .font(bodyFont)
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
    const pageWidth = doc.page.width;
    const leftMargin = 50;
    const contentWidth = pageWidth - 100;

    const headerFont = this.getFontOrFallback(
      doc,
      'TitleBold',
      'Helvetica-Bold',
    );
    const bodyFont = this.getFontOrFallback(doc, 'BodyRegular', 'Helvetica');

    // Title
    doc
      .fontSize(18)
      .font(headerFont)
      .text('Table of Contents', leftMargin, 50, {
        width: contentWidth,
        align: 'center',
      });

    doc.moveDown(1);

    const cleanedContent = this.cleanTableOfContents(content);
    const lines = cleanedContent.split('\n').filter((l) => l.trim());

    lines.forEach((line) => {
      const trimmed = line.trim();

      // Skip empty or redundant lines
      if (!trimmed || this.isRedundantTOCLine(trimmed)) {
        return;
      }

      // Chapter headings (e.g., "Chapter 1", "Kapitel 1", etc.)
      if (this.isChapterHeading(trimmed)) {
        doc.moveDown(0.8);
        doc
          .fontSize(12)
          .font(headerFont)
          .fillColor('#2C3E50')
          .text(trimmed, leftMargin, doc.y, {
            continued: false,
            align: 'left',
          });
        doc.fillColor('#000000');
        doc.moveDown(1);
        return;
      }

      // Main chapter titles (not indented)
      if (!trimmed.startsWith(' ') && trimmed.length > 0) {
        const indent = leftMargin + 20;
        doc
          .fontSize(8)
          .font(bodyFont)
          .text(trimmed, indent, doc.y, {
            continued: false,
            width: contentWidth - 20,
            align: 'left',
          });
        doc.moveDown(0.4);
        return;
      }

      // Sub-sections (single indent)
      if (trimmed.match(/^\s{1,4}\S/)) {
        const indent = leftMargin + 40;
        doc
          .fontSize(8)
          .font(bodyFont)
          .fillColor('#34495E')
          .text(trimmed.trim(), indent, doc.y, {
            continued: false,
            width: contentWidth - 40,
            align: 'left',
          });
        doc.fillColor('#000000');
        doc.moveDown(0.3);
        return;
      }

      // Sub-sub-sections (double indent)
      const indent = leftMargin + 60;
      doc
        .fontSize(6)
        .font(bodyFont)
        .fillColor('#7F8C8D')
        .text(trimmed.trim(), indent, doc.y, {
          continued: false,
          width: contentWidth - 60,
          align: 'left',
        });
      doc.fillColor('#000000');
      doc.moveDown(2);
    });
  }

  private addChapterTitle(
    doc: PDFKit.PDFDocument,
    title: string,
    chapterNumber: number,
  ): void {
    const cleanTitle = this.cleanText(title);
    const titleFont = this.getFontOrFallback(
      doc,
      'TitleBold',
      'Helvetica-Bold',
    );

    // Only show "Chapter X" for actual content chapters (chapterNumber > 0)
    if (chapterNumber > 0) {
      doc.fontSize(20).font(titleFont).text(`Chapter ${chapterNumber}`, {
        align: 'center',
      });
      doc.moveDown(1);
    }

    // Always show the chapter title
    doc.fontSize(20).font(titleFont).text(cleanTitle, {
      align: 'center',
    });
    doc.moveDown(1);
  }

  private addFormattedContent(
    doc: PDFKit.PDFDocument,
    content: string,
    bookTitle?: string,
    bookSubtitle?: string,
  ): void {
    // Use aggressive cleaning
    const cleanedContent = this.cleanContent(content);
    const sections = cleanedContent.split('\n\n').filter((p) => p.trim());

    const bodyFont = this.getFontOrFallback(doc, 'BodyRegular', 'Helvetica');
    const headerFont = this.getFontOrFallback(
      doc,
      'BodyBold',
      'Helvetica-Bold',
    );

    sections.forEach((section, index) => {
      let trimmed = section.trim();

      // Additional cleaning pass for each section
      trimmed = trimmed.replace(/[*_~`#\[\]{}|^]/g, ''); // Remove any remaining markdown
      trimmed = trimmed.replace(/  +/g, ' '); // Clean multiple spaces
      trimmed = trimmed.trim();

      const lowerTrimmed = trimmed.toLowerCase();

      // Skip various redundant content
      if (
        this.shouldSkipSection(trimmed, lowerTrimmed, bookTitle, bookSubtitle)
      ) {
        return;
      }

      const isHeader = this.isHeaderSection(trimmed);

      if (isHeader) {
        doc.fontSize(14).font(headerFont).text(trimmed, {
          align: 'left',
          lineGap: 5,
        });
        doc.moveDown(0.5);
      } else {
        doc.fontSize(11).font(bodyFont).text(trimmed, {
          align: 'left',
          lineGap: 5,
        });

        if (index < sections.length - 1) {
          doc.moveDown(0.5);
        }
      }
    });
  }

  // 5. NEW helper method - should skip section?
  private shouldSkipSection(
    trimmed: string,
    lowerTrimmed: string,
    bookTitle?: string,
    bookSubtitle?: string,
  ): boolean {
    // Skip if it's a redundant line
    if (this.isRedundantLine(trimmed)) return true;

    // Skip chapter number lines
    if (/^Chapter\s+\d+$/i.test(trimmed)) return true;
    if (/^Kapitel\s+\d+$/i.test(trimmed)) return true;
    if (/^Chapitre\s+\d+$/i.test(trimmed)) return true;
    if (/^Capitolo\s+\d+$/i.test(trimmed)) return true;

    // Skip chapter title text that matches the header
    if (
      trimmed.length < 100 &&
      /^(Chapter|Kapitel|Chapitre|Capitolo)\s+\d+/i.test(trimmed) &&
      trimmed.split(' ').length <= 15
    ) {
      return true;
    }

    // Skip book title/subtitle if they appear in content
    if (bookTitle && lowerTrimmed === bookTitle.toLowerCase()) return true;
    if (bookSubtitle && lowerTrimmed === bookSubtitle.toLowerCase())
      return true;

    // Skip title-like content
    if (
      trimmed.length < 150 &&
      !trimmed.includes('.') &&
      trimmed.split(' ').length <= 15 &&
      (trimmed === trimmed.toUpperCase() || this.isTitleCase(trimmed))
    ) {
      if (
        bookTitle &&
        this.similarText(lowerTrimmed, bookTitle.toLowerCase())
      ) {
        return true;
      }
      if (
        bookSubtitle &&
        this.similarText(lowerTrimmed, bookSubtitle.toLowerCase())
      ) {
        return true;
      }
    }

    return false;
  }

  // 6. NEW helper method - is header section?
  private isHeaderSection(trimmed: string): boolean {
    return (
      trimmed.length < 100 &&
      !trimmed.includes('.') &&
      trimmed.split(' ').length <= 10 &&
      trimmed.split(' ').length > 0
    );
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
    const cleanedContent = this.cleanFrontMatterContent(content);

    const bodyFont = this.getFontOrFallback(doc, 'BodyRegular', 'Helvetica');

    doc
      .fontSize(11)
      .font(bodyFont)
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
          doc.moveDown(0.5);

          const imageHeight = 182.16;
          const totalSpaceNeeded = imageHeight + 80;

          if (
            doc.y + totalSpaceNeeded >
            doc.page.height - doc.page.margins.bottom
          ) {
            doc.addPage();
            doc.moveDown(0.5);
          }

          await this.insertImage(doc, image, redisCache);

          doc.moveDown(0.5);

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

    const titleFont = this.getFontOrFallback(
      doc,
      'TitleBold',
      'Helvetica-Bold',
    );

    try {
      doc.fontSize(30).font(titleFont).text('Geographical Map', {
        align: 'center',
      });
      doc.moveDown(0.5);

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
    const pageHeight = doc.page.height; // 648
    const pageWidth = doc.page.width; // 432

    const yPosition = pageHeight - 50;

    doc.save();

    // Reset margins temporarily to allow absolute positioning
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

    const bodyFont = this.getFontOrFallback(doc, 'BodyRegular', 'Helvetica');

    doc
      .fontSize(10)
      .font(bodyFont)
      .fillColor('#666666')
      .text(pageNumber.toString(), 0, yPosition, {
        align: 'center',
        width: pageWidth,
        lineBreak: false,
        baseline: 'top', // Ensures text starts exactly at yPosition
      });

    doc.restore();

    doc.fillColor('#000000');
  }

  // Helper method to get font or fallback
  private getFontOrFallback(
    doc: PDFKit.PDFDocument,
    customFont: string,
    fallbackFont: string,
  ): string {
    // Check if custom font exists by checking registered fonts
    // Don't try to set it yet - just return the name
    try {
      // Try a safe operation that won't change the document
      const testDoc = doc;
      // If the font was registered, it should be available
      // We'll just return the font name and let the caller use it
      return customFont;
    } catch (error) {
      return fallbackFont;
    }
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

    let cleaned = text;

    // ==========================================
    // STEP 1: Remove ALL Markdown Syntax
    // ==========================================

    // Bold: **text** or __text__
    cleaned = cleaned.replace(/\*\*\*(.+?)\*\*\*/g, '$1'); // Triple asterisk (bold+italic)
    cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, '$1'); // Double asterisk (bold)
    cleaned = cleaned.replace(/___(.+?)___/g, '$1'); // Triple underscore
    cleaned = cleaned.replace(/__(.+?)__/g, '$1'); // Double underscore (bold)

    // Italic: *text* or _text_
    cleaned = cleaned.replace(/\*(.+?)\*/g, '$1'); // Single asterisk (italic)
    cleaned = cleaned.replace(/_(.+?)_/g, '$1'); // Single underscore (italic)

    // Strikethrough: ~~text~~
    cleaned = cleaned.replace(/~~(.+?)~~/g, '$1');

    // Code: `text` or ```text```
    cleaned = cleaned.replace(/```[\s\S]*?```/g, ''); // Code blocks
    cleaned = cleaned.replace(/`(.+?)`/g, '$1'); // Inline code

    // Headers: # ## ### #### ##### ######
    cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');

    // Links: [text](url) or [text][ref]
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1'); // [text](url)
    cleaned = cleaned.replace(/\[([^\]]+)\]\[[^\]]+\]/g, '$1'); // [text][ref]

    // Images: ![alt](url)
    cleaned = cleaned.replace(/!\[([^\]]*)\]\([^\)]+\)/g, '');

    // Horizontal rules: --- or *** or ___
    cleaned = cleaned.replace(/^(\*{3,}|-{3,}|_{3,})$/gm, '');

    // Blockquotes: > text
    cleaned = cleaned.replace(/^>\s+/gm, '');

    // Lists: - item or * item or + item or 1. item
    cleaned = cleaned.replace(/^[\*\-\+]\s+/gm, ''); // Unordered lists
    // cleaned = cleaned.replace(/^\d+\.\s+/gm, ''); // Ordered lists

    // ==========================================
    // STEP 2: Remove Special Characters & Symbols
    // ==========================================

    // Remove leftover asterisks (not caught by regex)
    cleaned = cleaned.replace(/\*+/g, '');

    // Remove leftover underscores (not caught by regex)
    cleaned = cleaned.replace(/_{2,}/g, '');

    // Remove HTML tags if any
    cleaned = cleaned.replace(/<[^>]*>/g, '');

    // Remove bullet points and special list markers
    cleaned = cleaned.replace(/[•●○◦■□▪▫]/g, '');

    // Replace smart quotes with regular quotes
    cleaned = cleaned.replace(/[""]/g, '"');
    cleaned = cleaned.replace(/['']/g, "'");

    // Replace em dashes and en dashes with regular hyphen
    cleaned = cleaned.replace(/[–—]/g, '-');

    // Remove ellipsis character
    cleaned = cleaned.replace(/…/g, '...');

    // Remove zero-width spaces and other invisible characters
    cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, '');

    // Remove multiple hyphens/dashes
    cleaned = cleaned.replace(/-{2,}/g, '-');

    // ==========================================
    // STEP 3: Clean Up Whitespace
    // ==========================================

    // Replace multiple spaces with single space
    cleaned = cleaned.replace(/  +/g, ' ');

    // Replace multiple newlines with single newline
    cleaned = cleaned.replace(/\n\n+/g, '\n\n');

    // Remove spaces at start/end of lines
    cleaned = cleaned.replace(/^[ \t]+|[ \t]+$/gm, '');

    // Final trim
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * AGGRESSIVE cleanContent - cleans entire content blocks
   * Use this to replace the existing cleanContent method
   */
  private cleanContent(content: string): string {
    if (!content) return '';

    // First pass - aggressive cleaning
    let cleaned = content;

    // ==========================================
    // REMOVE ALL MARKDOWN FORMATTING
    // ==========================================

    // Bold variations
    cleaned = cleaned.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
    cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, '$1');
    cleaned = cleaned.replace(/___(.+?)___/g, '$1');
    cleaned = cleaned.replace(/__(.+?)__/g, '$1');

    // Italic variations
    cleaned = cleaned.replace(/\*(.+?)\*/g, '$1');
    cleaned = cleaned.replace(/_(.+?)_/g, '$1');

    // Other markdown
    cleaned = cleaned.replace(/~~(.+?)~~/g, '$1'); // Strikethrough
    cleaned = cleaned.replace(/`(.+?)`/g, '$1'); // Inline code
    cleaned = cleaned.replace(/```[\s\S]*?```/g, ''); // Code blocks
    cleaned = cleaned.replace(/^#{1,6}\s+/gm, ''); // Headers
    cleaned = cleaned.replace(/^[\*\-\+]\s+/gm, ''); // List items
    cleaned = cleaned.replace(/^\d+\.\s+/gm, ''); // Numbered lists
    cleaned = cleaned.replace(/^>\s+/gm, ''); // Blockquotes

    // Links and images
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
    cleaned = cleaned.replace(/!\[([^\]]*)\]\([^\)]+\)/g, '');

    // ==========================================
    // REMOVE LEFTOVER SYMBOLS
    // ==========================================

    // Remove any remaining asterisks
    cleaned = cleaned.replace(/\*+/g, '');

    // Remove any remaining underscores (but keep single underscores in words)
    cleaned = cleaned.replace(/_{2,}/g, '');
    cleaned = cleaned.replace(/\s_\s/g, ' ');
    cleaned = cleaned.replace(/^_|_$/gm, '');

    // Remove bullets and special characters
    cleaned = cleaned.replace(/[•●○◦■□▪▫◆◇]/g, '');

    // Replace smart quotes
    cleaned = cleaned.replace(/[""]/g, '"');
    cleaned = cleaned.replace(/['']/g, "'");

    // Replace dashes
    cleaned = cleaned.replace(/[–—]/g, '-');
    cleaned = cleaned.replace(/-{2,}/g, '-');

    // Remove HTML tags
    cleaned = cleaned.replace(/<[^>]*>/g, '');

    // ==========================================
    // CLEAN UP CHAPTER REFERENCES
    // ==========================================

    cleaned = this.removeRedundantChapterReferences(cleaned);

    // ==========================================
    // PROCESS PARAGRAPHS
    // ==========================================

    const paragraphs = cleaned.split('\n\n');
    const cleanedParagraphs = paragraphs
      .map((para) => {
        // Clean each paragraph individually
        let cleanPara = this.cleanText(para);

        // Additional aggressive cleaning for persistent symbols
        cleanPara = cleanPara.replace(/[*_~`#]/g, ''); // Remove any remaining markdown chars
        cleanPara = cleanPara.replace(/\[|\]/g, ''); // Remove brackets
        cleanPara = cleanPara.replace(/\{|\}/g, ''); // Remove braces

        return cleanPara;
      })
      .filter((para) => {
        // Filter out empty or redundant paragraphs
        const trimmed = para.trim();
        if (!trimmed) return false;
        if (trimmed.length < 3) return false;
        if (this.isRedundantLine(trimmed)) return false;
        return true;
      });

    return cleanedParagraphs.join('\n\n');
  }

  // 2. NEW method to remove redundant chapter references
  private removeRedundantChapterReferences(content: string): string {
    // Remove lines that are just chapter headings repeated in content
    const lines = content.split('\n');
    const filtered = lines.filter((line, index) => {
      const trimmed = line.trim();

      // Skip empty lines
      if (!trimmed) return true;

      // Remove standalone "Chapter X" lines
      if (/^Chapter\s+\d+$/i.test(trimmed)) return false;
      if (/^Kapitel\s+\d+$/i.test(trimmed)) return false; // German
      if (/^Chapitre\s+\d+$/i.test(trimmed)) return false; // French
      if (/^Capitolo\s+\d+$/i.test(trimmed)) return false; // Italian
      if (/^Capítulo\s+\d+$/i.test(trimmed)) return false; // Spanish

      // Remove lines like "Chapter 1 Introduction: Title"
      if (
        /^Chapter\s+\d+\s+[A-Z]/i.test(trimmed) &&
        trimmed.split(' ').length <= 10
      ) {
        return false;
      }

      // Remove lines that look like repeated chapter titles at start of content
      if (
        index < 5 &&
        trimmed.length < 100 &&
        !trimmed.includes('.') &&
        trimmed.split(' ').length <= 15
      ) {
        // Likely a repeated title
        return false;
      }

      return true;
    });

    return filtered.join('\n');
  }

  // 3. NEW method to identify redundant lines
  private isRedundantLine(text: string): boolean {
    const trimmed = text.trim();

    // Empty or very short
    if (trimmed.length < 3) return true;

    // Just punctuation
    if (/^[^\w\s]+$/.test(trimmed)) return true;

    // Repeated markdown syntax leftovers
    if (/^[\*_#`~-]+$/.test(trimmed)) return true;

    // Lines with only numbers
    if (/^\d+$/.test(trimmed)) return true;

    // Common redundant phrases in multiple languages
    const redundantPhrases = [
      // English
      'chapter',
      'table of contents',
      'introduction',
      // German
      'kapitel',
      'inhaltsverzeichnis',
      'einführung',
      // French
      'chapitre',
      'sommaire',
      'table des matières',
      // Italian
      'capitolo',
      'sommario',
      'introduzione',
      // Spanish
      'capítulo',
      'índice',
      'introducción',
    ];

    const lower = trimmed.toLowerCase();

    // If it's ONLY a redundant phrase (nothing else)
    if (redundantPhrases.some((phrase) => lower === phrase)) {
      return true;
    }

    return false;
  }

  private cleanFrontMatterContent(content: string): string {
    const cleaned = this.cleanContent(content);
    const paragraphs = cleaned.split('\n\n').filter((p) => p.trim());

    return paragraphs
      .filter((para) => {
        const trimmed = para.trim();
        const lower = trimmed.toLowerCase();

        // Skip the heading itself if it appears in content
        const frontMatterHeadings = [
          'about this book',
          'about book',
          'about the',
          'über dieses buch',
          'über das buch',
          'à propos du livre',
          'à propos',
          'informazioni su',
          'sul libro',
          'copyright',
          'urheberrecht',
          "droit d'auteur",
          "diritto d'autore",
        ];

        if (
          frontMatterHeadings.some((heading) => lower.includes(heading)) &&
          trimmed.length < 50
        ) {
          return false;
        }

        // Keep everything else
        return trimmed.length > 0;
      })
      .join('\n\n');
  }

  private cleanTableOfContents(content: string): string {
    let cleaned = this.cleanContent(content);

    // Remove the heading itself if it appears multiple times
    const lines = cleaned.split('\n');
    const filtered = lines.filter((line, index) => {
      const trimmed = line.trim();
      const lower = trimmed.toLowerCase();

      // Skip TOC heading duplicates (keep only if it's very first line)
      const tocHeadings = [
        'table of contents',
        'inhaltsverzeichnis',
        'table des matières',
        'sommaire',
        'tabella dei contenuti',
        'índice',
      ];

      if (tocHeadings.some((heading) => lower.includes(heading))) {
        // If it's short and looks like just the heading
        if (trimmed.length < 50) {
          return false; // Skip it, we add it ourselves
        }
      }

      return true;
    });

    return filtered.join('\n');
  }

  // 4. NEW helper - is redundant TOC line?
  private isRedundantTOCLine(line: string): boolean {
    const lower = line.toLowerCase();

    // Redundant TOC headings
    const headings = [
      'table of contents',
      'inhaltsverzeichnis',
      'table des matières',
      'sommaire',
      'tabella dei contenuti',
      'índice',
    ];

    if (headings.some((h) => lower.includes(h)) && line.length < 50) {
      return true;
    }

    // Other redundant patterns
    if (line.length < 2) return true;
    if (/^[^\w\s]+$/.test(line)) return true;
    if (/^\d+$/.test(line)) return true;

    return false;
  }

  // 5. NEW helper - is chapter heading?
  private isChapterHeading(line: string): boolean {
    // Match "Chapter 1", "Kapitel 1", "Chapitre 1", "Capitolo 1", "Capítulo 1"
    return /^(Chapter|Kapitel|Chapitre|Capitolo|Capítulo)\s+\d+$/i.test(line);
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
