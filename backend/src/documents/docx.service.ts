// src/modules/document/docx.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ImageRun,
  PageNumber,
  Footer,
  NumberFormat,
} from 'docx';
import axios from 'axios';
import { RedisCacheService } from 'src/queues/cache/redis-cache.service';

@Injectable()
export class DocxService {
  private readonly logger = new Logger(DocxService.name);

  // Define your preferred fonts
  private readonly FONTS = {
    title: 'Garamond', // Elegant serif for titles
    body: 'Georgia', // Readable serif for body text
    heading: 'Book Antiqua', // Classic for headings
  };

  constructor(private configService: ConfigService) {}

  async generateDOCXBuffer(
    title: string,
    subtitle: string,
    author: string,
    chapters: any[],
    images: any[] = [],
    redisCache: RedisCacheService,
  ): Promise<{ buffer: Buffer; filename: string }> {
    let doc: Document | null = null;
    let allSections: Paragraph[] = [];

    try {
      this.logMemory('DOCX Start');

      const filename = `${this.sanitizeFilename(title)}_${Date.now()}.docx`;

      // Build sections with aggressive cleanup
      allSections = await this.buildSectionsInBatches(
        title,
        subtitle,
        author,
        chapters,
        images,
        redisCache,
      );

      this.logMemory('After Building Sections');

      // Create document with page numbers on ALL pages
      doc = new Document({
        sections: [
          {
            properties: {
              page: {
                size: { width: 8640, height: 12960 },
                margin: { top: 1656, bottom: 1656, left: 1440, right: 1440 },
                pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL },
              },
            },
            footers: {
              default: new Footer({
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({
                        children: [PageNumber.CURRENT],
                        size: 20,
                        font: this.FONTS.body,
                      }),
                    ],
                  }),
                ],
              }),
            },
            children: allSections,
          },
        ],
      });

      this.logMemory('After Document Creation');

      // Clear sections array before packing
      allSections = [];
      this.forceGC();

      // Generate buffer
      const buffer = await Packer.toBuffer(doc);

      this.logger.log(`DOCX generated: ${filename} (${buffer.length} bytes)`);
      this.logMemory('DOCX Complete');

      return { buffer, filename };
    } catch (error) {
      this.logger.error('Error generating DOCX:', error);
      throw error;
    } finally {
      // Aggressive cleanup
      doc = null;
      allSections = [];

      this.forceGC(3);
      await this.delay(500);
    }
  }

  private async buildSectionsInBatches(
    title: string,
    subtitle: string,
    author: string,
    chapters: any[],
    images: any[],
    redisCache: RedisCacheService,
  ): Promise<Paragraph[]> {
    const allSections: Paragraph[] = [];

    // BATCH 1: Front Matter
    this.logger.log('Building front matter...');
    const frontMatter = this.buildFrontMatter(
      title,
      subtitle,
      author,
      chapters,
    );
    allSections.push(...frontMatter);
    frontMatter.length = 0;
    this.forceGC();
    this.logMemory('After Front Matter');

    // BATCH 2: Main Chapters (ONE AT A TIME)
    const mainChapters = chapters
      .filter((c) => !this.isFrontMatterChapter(c.title))
      .sort((a, b) => a.order - b.order);

    for (let i = 0; i < mainChapters.length; i++) {
      const chapter = mainChapters[i];

      // ✅ Calculate proper chapter number (starting from 1)
      const chapterNumber = i + 1;

      this.logger.log(`Building chapter ${chapterNumber}...`);

      const chapterSections = await this.buildChapterSections(
        chapter,
        images,
        redisCache,
        title, // ADD THIS
        subtitle, // ADD THIS
        chapterNumber,
      );
      allSections.push(...chapterSections);

      chapterSections.length = 0;
      this.forceGC(2);

      if (i % 2 === 1 || i === mainChapters.length - 1) {
        this.logMemory(`After chapters ${i - (i % 2) + 1}-${i + 1}`);
      }

      await this.delay(200);
    }

    // BATCH 3: Map Page
    const mapImage = images.find((img) => img.isMap);
    if (mapImage) {
      this.logger.log('Building map page...');
      const mapSections = await this.createMapPage(mapImage, redisCache);
      allSections.push(...mapSections);
      mapSections.length = 0;
      this.forceGC();
      this.logMemory('After Map');
    }

    return allSections;
  }

  private buildFrontMatter(
    title: string,
    subtitle: string,
    author: string,
    chapters: any[],
  ): Paragraph[] {
    const sections: Paragraph[] = [];

    sections.push(...this.createTitlePage(title, subtitle, author));

    const copyrightChapter = chapters.find((c) =>
      this.isCopyrightChapter(c.title),
    );
    if (copyrightChapter) {
      sections.push(...this.createCopyrightPage(copyrightChapter.content));
    }

    const aboutChapter = chapters.find((c) => this.isAboutChapter(c.title));
    if (aboutChapter) {
      sections.push(...this.createAboutPage(aboutChapter.content));
    }

    const tocChapter = chapters.find((c) =>
      this.isTableOfContentsChapter(c.title),
    );
    if (tocChapter) {
      sections.push(...this.createTableOfContents(tocChapter.content));
    }

    return sections;
  }

  private async buildChapterSections(
    chapter: any,
    images: any[],
    redisCache: RedisCacheService,
    bookTitle?: string,
    bookSubtitle?: string,
    chapterNumber?: number, // Add this parameter
  ): Promise<Paragraph[]> {
    const sections: Paragraph[] = [];

    // Check if this is front matter
    const isFrontMatter = this.isFrontMatterChapter(chapter.title);

    // sections.push(new Paragraph({ text: '', pageBreakBefore: true }));

    if (isFrontMatter) {
      // For front matter: Just show the title, NO "Chapter X"
      const cleanTitle = this.cleanText(chapter.title);

      sections.push(
        new Paragraph({
          // text: cleanTitle,
          alignment: AlignmentType.CENTER,
          spacing: { before: 50, after: 100 },
          pageBreakBefore: true,
          children: [
            new TextRun({
              text: cleanTitle,
              bold: true,
              size: 40,
              font: this.FONTS.heading,
            }),
          ],
        }),
      );
    } else {
      // For content chapters: Show "Chapter X" + Title
      // Use the passed chapterNumber parameter
      const displayNumber = chapterNumber;
      const cleanTitle = this.cleanText(chapter.title);

      sections.push(
        new Paragraph({
          // text: `Chapter ${displayNumber}`,
          alignment: AlignmentType.CENTER,
          spacing: { before: 50, after: 100 },
          pageBreakBefore: true,
          children: [
            new TextRun({
              text: `Chapter ${displayNumber}`,
              size: 40,
              font: this.FONTS.heading,
              bold: true,
            }),
          ],
        }),
      );

      sections.push(
        new Paragraph({
          // text: cleanTitle,
          alignment: AlignmentType.CENTER,
          spacing: { after: 100 },
          children: [
            new TextRun({
              text: cleanTitle,
              bold: true,
              size: 40,
              font: this.FONTS.title,
            }),
          ],
        }),
      );
    }

    // Get chapter images (only for content chapters)
    const chapterImages = isFrontMatter
      ? []
      : images
          .filter((img) => img.chapterNumber === chapterNumber && !img.isMap)

          .sort((a, b) => (a.position || 0) - (b.position || 0));

    if (chapterImages.length > 0) {
      const contentSections = await this.createContentWithImages(
        chapter.content,
        chapterImages,
        redisCache,
        bookTitle,
        bookSubtitle,
      );
      sections.push(...contentSections);
      contentSections.length = 0;
    } else {
      const contentSections = this.createFormattedContent(
        chapter.content,
        bookTitle,
        bookSubtitle,
      );
      sections.push(...contentSections);
      contentSections.length = 0;
    }

    return sections;
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
      // Spanish
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

  private async createContentWithImages(
    content: string,
    chapterImages: any[],
    redisCache: RedisCacheService,
    bookTitle?: string,
    bookSubtitle?: string,
  ): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];
    const textParagraphs = content.split('\n\n').filter((p) => p.trim());
    const sections = this.createContentSections(
      textParagraphs,
      chapterImages.length,
    );

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];

      if (section.paragraphs.length > 0) {
        const textContent = this.createFormattedContent(
          section.paragraphs.join('\n\n'),
          bookTitle,
          bookSubtitle,
        );
        paragraphs.push(...textContent);
        textContent.length = 0;
      }

      if (
        section.imageIndex !== undefined &&
        chapterImages[section.imageIndex]
      ) {
        const image = chapterImages[section.imageIndex];

        paragraphs.push(
          new Paragraph({ text: '', spacing: { before: 100, after: 100 } }),
        );

        try {
          const imageParagraphs = await this.createImageParagraph(
            image,
            redisCache,
          );
          paragraphs.push(...imageParagraphs);
          imageParagraphs.length = 0;

          this.forceGC();
          await this.delay(100);
        } catch (error) {
          this.logger.error(`Failed to insert image ${image.filename}:`, error);
        }

        paragraphs.push(
          new Paragraph({ text: '', spacing: { before: 100, after: 100 } }),
        );
      }
    }

    return paragraphs;
  }

  private async createImageParagraph(
    image: any,
    redisCache: RedisCacheService,
  ): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];
    let imageBuffer: Buffer | null = null;

    try {
      imageBuffer = await redisCache.getImage(image.url);

      if (!imageBuffer) {
        this.logger.warn(
          `⚠ Image not in Redis, downloading: ${image.url.substring(image.url.lastIndexOf('/') + 1)}`,
        );
        imageBuffer = await this.downloadImageWithRetry(image.url);
      } else {
        this.logger.debug(
          `✓ Retrieved from Redis: ${image.url.substring(image.url.lastIndexOf('/') + 1)}`,
        );
      }

      const imageType = this.getImageType(image.mimeType || image.url);

      const availableWidthInches = 4.0; // Content area width
      const imageWidthInches = availableWidthInches * 0.9; // 3.6 inches (90% of content width)

      // Maintain aspect ratio from PDF: 286.56 width / 182.16 height = 1.573
      const aspectRatio = 1.573;
      const imageHeightInches = imageWidthInches / aspectRatio; // ~2.29 inches

      // Convert inches to EMU (English Metric Units)
      // 1 inch = 914,400 EMU
      const widthInEMU = Math.round(imageWidthInches * 914400); // 3,291,840 EMU
      const heightInEMU = Math.round(imageHeightInches * 914400); // 2,093,856 EMU

      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: imageBuffer,
              type: imageType,
              transformation: { width: widthInEMU, height: heightInEMU },
            }),
          ],
          spacing: { before: 200, after: 200 },
        }),
      );
    } catch (error) {
      this.logger.error('Error creating image paragraph:', error);
    } finally {
      imageBuffer = null;
      this.forceGC();
    }

    return paragraphs;
  }

  private async createMapPage(
    mapImage: any,
    redisCache: RedisCacheService,
  ): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];
    let imageBuffer: Buffer | null = null;

    try {
      // paragraphs.push(new Paragraph({ text: '', pageBreakBefore: true }));
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 100 },
          pageBreakBefore: true,
          children: [
            new TextRun({
              text: `Geographical Map`,
              size: 40,
              font: this.FONTS.heading,
              bold: true,
            }),
          ],
        }),
      );

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

      const imageType = this.getImageType(mapImage.mimeType || mapImage.url);

      const availableWidthInches = 4.0;
      const mapWidthInches = availableWidthInches * 0.9; // 3.4 inches

      // Maintain aspect ratio from PDF: 285.84 width / 421.2 height = 0.6787
      const aspectRatio = 0.6787; // width/height (map is portrait)
      const mapHeightInches = mapWidthInches / aspectRatio; // ~5.01 inches

      // Convert to EMU
      const widthInEMU = Math.round(mapWidthInches * 914400); // 3,108,960 EMU
      const heightInEMU = Math.round(mapHeightInches * 914400); // 4,581,144 EMU

      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: imageBuffer,
              type: imageType,
              transformation: { width: widthInEMU, height: heightInEMU },
            }),
          ],
        }),
      );
    } catch (error) {
      this.logger.error('Error creating map image:', error);
    } finally {
      imageBuffer = null;
      this.forceGC();
    }

    return paragraphs;
  }

  private createTitlePage(
    title: string,
    subtitle: string,
    author: string,
  ): Paragraph[] {
    return [
      new Paragraph({
        // text: title.toUpperCase(),
        alignment: AlignmentType.CENTER,
        spacing: { before: 100, after: 800 },
        children: [
          new TextRun({
            text: title.toUpperCase(),
            bold: true,
            size: 64,
            font: this.FONTS.title,
          }),
        ],
      }),
      new Paragraph({
        // text: subtitle,
        alignment: AlignmentType.CENTER,
        spacing: { after: 600 },
        children: [
          new TextRun({ text: subtitle, size: 20, font: this.FONTS.body }),
        ],
      }),
      new Paragraph({
        // text: 'By',
        alignment: AlignmentType.CENTER,
        spacing: { after: 600 },
        children: [
          new TextRun({ text: 'By', size: 22, font: this.FONTS.body }),
        ],
      }),
      new Paragraph({
        // text: author.toUpperCase(),
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: author.toUpperCase(),
            bold: true,
            size: 32,
            font: this.FONTS.title,
          }),
        ],
      }),
    ];
  }

  private createCopyrightPage(content: string): Paragraph[] {
    const cleanedContent = this.cleanFrontMatterContent(content);
    return [
      // new Paragraph({ text: '', pageBreakBefore: true }),
      new Paragraph({
        children: [
          new TextRun({
            text: cleanedContent,
            size: 18,
            font: this.FONTS.body,
          }),
        ],
        spacing: { after: 200 },
        pageBreakBefore: true,
      }),
    ];
  }

  private createAboutPage(content: string): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    // paragraphs.push(new Paragraph({ text: '', pageBreakBefore: true }));
    paragraphs.push(
      new Paragraph({
        // text: 'About Book',
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 100 },
        pageBreakBefore: true,
        children: [
          new TextRun({
            text: 'About Book',
            bold: true,
            size: 36,
            font: this.FONTS.heading,
          }),
        ],
      }),
    );

    const cleanedContent = this.cleanFrontMatterContent(content);
    const sections = cleanedContent.split('\n\n').filter((p) => p.trim());

    sections.forEach((section) => {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: section.trim(),
              size: 22,
              font: this.FONTS.body,
            }),
          ],
          spacing: { after: 200 },
          alignment: AlignmentType.LEFT,
        }),
      );
    });

    return paragraphs;
  }

  private createTableOfContents(content: string): Paragraph[] {
    const paragraphs: Paragraph[] = [];

    // Page break and title
    // paragraphs.push(new Paragraph({ text: '', pageBreakBefore: true }));
    paragraphs.push(
      new Paragraph({
        // text: 'Table of Contents',
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
        pageBreakBefore: true,
        children: [
          new TextRun({
            text: 'Table of Contents',
            bold: true,
            size: 40,
            font: this.FONTS.heading,
          }),
        ],
      }),
    );

    const cleanedContent = this.cleanTableOfContents(content);
    const lines = cleanedContent.split('\n').filter((l) => l.trim());

    lines.forEach((line) => {
      const trimmed = line.trim();

      // Skip empty or redundant lines
      if (!trimmed || this.isRedundantTOCLine(trimmed)) {
        return;
      }

      // Chapter headings
      if (this.isChapterHeading(trimmed)) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmed,
                bold: true,
                size: 24,
                color: '2C3E50',
                font: this.FONTS.heading,
              }),
            ],
            spacing: { before: 300, after: 100 },
            indent: { left: 0 },
          }),
        );
        return;
      }

      // Main chapter titles
      if (!trimmed.startsWith(' ') && trimmed.length > 0) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmed,
                size: 22,
                bold: false,
                font: this.FONTS.body,
              }),
            ],
            spacing: { after: 120 },
            indent: { left: 360 },
          }),
        );
        return;
      }

      // Sub-sections
      if (trimmed.match(/^\s{1,4}\S/)) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmed.trim(),
                size: 20,
                color: '34495E',
                font: this.FONTS.body,
              }),
            ],
            spacing: { after: 80 },
            indent: { left: 720 },
          }),
        );
        return;
      }

      // Sub-sub-sections
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: trimmed.trim(),
              size: 18,
              color: '7F8C8D',
              font: this.FONTS.body,
            }),
          ],
          spacing: { after: 60 },
          indent: { left: 1080 },
        }),
      );
    });

    return paragraphs;
  }

  private createFormattedContent(
    content: string,
    bookTitle?: string,
    bookSubtitle?: string,
  ): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    // Use aggressive cleaning
    const cleanedContent = this.cleanContent(content);
    const sections = cleanedContent.split('\n\n').filter((p) => p.trim());

    sections.forEach((section) => {
      let trimmed = section.trim();

      // Additional cleaning pass
      trimmed = trimmed.replace(/[*_~`#\[\]{}|^]/g, '');
      trimmed = trimmed.replace(/  +/g, ' ');
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
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmed,
                bold: true,
                size: 28,
                font: this.FONTS.heading,
              }),
            ],
            spacing: { before: 100, after: 100 },
            alignment: AlignmentType.LEFT,
          }),
        );
      } else {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: trimmed, size: 22, font: this.FONTS.body }),
            ],
            spacing: { after: 100 },
            alignment: AlignmentType.LEFT,
          }),
        );
      }
    });

    return paragraphs;
  }

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

  // Helper methods
  private isTitleCase(text: string): boolean {
    const words = text.split(' ');
    return words.every((word) => {
      if (word.length === 0) return true;
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
      return word[0] === word[0].toUpperCase();
    });
  }

  private similarText(str1: string, str2: string): boolean {
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
      sections.push({ paragraphs: sectionParagraphs, imageIndex: idx });
      lastIndex = position;
    });

    if (lastIndex < paragraphs.length) {
      sections.push({ paragraphs: paragraphs.slice(lastIndex) });
    }

    return sections;
  }

  private getImageType(mimeTypeOrUrl: string): 'jpg' | 'png' | 'gif' | 'bmp' {
    const lower = mimeTypeOrUrl.toLowerCase();
    if (lower.includes('png')) return 'png';
    if (lower.includes('gif')) return 'gif';
    if (lower.includes('bmp')) return 'bmp';
    return 'jpg';
  }

  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[^a-z0-9]/gi, '_')
      .replace(/_+/g, '_')
      .toLowerCase();
  }

  private forceGC(passes: number = 1): void {
    if (global.gc) {
      for (let i = 0; i < passes; i++) {
        global.gc();
      }
    }
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
