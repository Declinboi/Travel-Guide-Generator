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

@Injectable()
export class DocxService {
  private readonly logger = new Logger(DocxService.name);

  constructor(private configService: ConfigService) {}

  async generateDOCXBuffer(
    title: string,
    subtitle: string,
    author: string,
    chapters: any[],
    images: any[] = [],
    imageCache?: Map<string, Buffer>,
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
        imageCache,
      );

      this.logMemory('After Building Sections');

      // Create document
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
    imageCache?: Map<string, Buffer>,
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
    frontMatter.length = 0; // Clear source array
    this.forceGC();
    this.logMemory('After Front Matter');

    // BATCH 2: Main Chapters (ONE AT A TIME)
    const mainChapters = chapters
      .filter(
        (c) =>
          !['title', 'copyright', 'about', 'table'].some((k) =>
            c.title.toLowerCase().includes(k),
          ),
      )
      .sort((a, b) => a.order - b.order);

    for (let i = 0; i < mainChapters.length; i++) {
      const chapter = mainChapters[i];

      this.logger.log(`Building chapter ${i}...`);

      const chapterSections = await this.buildChapterSections(
        chapter,
        images,
        imageCache,
      );
      allSections.push(...chapterSections);

      // CRITICAL: Clear the temp array immediately
      chapterSections.length = 0;

      // Force GC after EVERY chapter
      this.forceGC(2);

      // Log every 2 chapters
      if (i % 2 === 1 || i === mainChapters.length - 1) {
        this.logMemory(`After chapters ${i - (i % 2) + 1}-${i + 1}`);
      }

      // Small delay to allow GC to complete
      await this.delay(200);
    }

    // BATCH 3: Map Page
    const mapImage = images.find((img) => img.isMap);
    if (mapImage) {
      this.logger.log('Building map page...');
      const mapSections = await this.createMapPage(mapImage, imageCache);
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
      c.title.toLowerCase().includes('copyright'),
    );
    if (copyrightChapter) {
      sections.push(...this.createCopyrightPage(copyrightChapter.content));
    }

    const aboutChapter = chapters.find((c) =>
      c.title.toLowerCase().includes('about'),
    );
    if (aboutChapter) {
      sections.push(...this.createAboutPage(aboutChapter.content));
    }

    const tocChapter = chapters.find((c) =>
      c.title.toLowerCase().includes('table'),
    );
    if (tocChapter) {
      sections.push(...this.createTableOfContents(tocChapter.content));
    }

    return sections;
  }

  private async buildChapterSections(
    chapter: any,
    images: any[],
    imageCache?: Map<string, Buffer>,
  ): Promise<Paragraph[]> {
    const sections: Paragraph[] = [];
    const chapterNumber = chapter.order - 3;
    const cleanTitle = this.cleanText(chapter.title);

    sections.push(new Paragraph({ text: '', pageBreakBefore: true }));

    sections.push(
      new Paragraph({
        text: `Chapter ${chapterNumber}`,
        alignment: AlignmentType.CENTER,
        spacing: { before: 240, after: 240 },
        children: [new TextRun({ text: `Chapter ${chapterNumber}`, size: 40 })],
      }),
    );

    sections.push(
      new Paragraph({
        text: cleanTitle,
        alignment: AlignmentType.CENTER,
        spacing: { after: 600 },
        children: [new TextRun({ text: cleanTitle, bold: true, size: 40 })],
      }),
    );

    const chapterImages = images
      .filter((img) => img.chapterNumber === chapterNumber && !img.isMap)
      .sort((a, b) => (a.position || 0) - (b.position || 0));

    if (chapterImages.length > 0) {
      const contentSections = await this.createContentWithImages(
        chapter.content,
        chapterImages,
        imageCache,
      );
      sections.push(...contentSections);
      contentSections.length = 0; // Clear immediately
    } else {
      const contentSections = this.createFormattedContent(chapter.content);
      sections.push(...contentSections);
      contentSections.length = 0;
    }

    return sections;
  }

  private async createContentWithImages(
    content: string,
    chapterImages: any[],
    imageCache?: Map<string, Buffer>,
  ): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];
    const textParagraphs = content.split('\n\n').filter((p) => p.trim());
    const sections = this.createContentSections(
      textParagraphs,
      chapterImages.length,
    );

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];

      // Add text
      if (section.paragraphs.length > 0) {
        const textContent = this.createFormattedContent(
          section.paragraphs.join('\n\n'),
        );
        paragraphs.push(...textContent);
        textContent.length = 0;
      }

      // Add image
      if (
        section.imageIndex !== undefined &&
        chapterImages[section.imageIndex]
      ) {
        const image = chapterImages[section.imageIndex];

        paragraphs.push(
          new Paragraph({ text: '', spacing: { before: 400, after: 200 } }),
        );

        try {
          const imageParagraphs = await this.createImageParagraph(
            image,
            imageCache,
          );
          paragraphs.push(...imageParagraphs);
          imageParagraphs.length = 0; // Clear immediately

          // Force GC after each image
          this.forceGC();
          await this.delay(100);
        } catch (error) {
          this.logger.error(`Failed to insert image ${image.filename}:`, error);
        }

        paragraphs.push(
          new Paragraph({ text: '', spacing: { before: 200, after: 400 } }),
        );
      }
    }

    return paragraphs;
  }

  private async createImageParagraph(
    image: any,
    imageCache?: Map<string, Buffer>,
  ): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];
    let imageBuffer: Buffer | null = null;

    try {
      if (imageCache && imageCache.has(image.url)) {
        imageBuffer = imageCache.get(image.url)!;
        this.logger.debug(
          `✓ Using cached image: ${image.url.substring(image.url.lastIndexOf('/') + 1)}`,
        );
      } else {
        this.logger.warn(
          `⚠ Image not in cache, downloading: ${image.url.substring(image.url.lastIndexOf('/') + 1)}`,
        );
        imageBuffer = await this.downloadImageWithRetry(image.url);
      }

      const imageType = this.getImageType(image.mimeType || image.url);
      const widthInEMU = Math.round(3.98 * 914400);
      const heightInEMU = Math.round(2.53 * 914400);

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
          spacing: { before: 300, after: 150 },
        }),
      );
    } catch (error) {
      this.logger.error('Error creating image paragraph:', error);
    } finally {
      // Don't clear buffer if from cache
      if (!imageCache || !imageCache.has(image.url)) {
        imageBuffer = null;
      }
      this.forceGC();
    }

    return paragraphs;
  }

  private async createMapPage(
    mapImage: any,
    imageCache?: Map<string, Buffer>,
  ): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];
    let imageBuffer: Buffer | null = null;

    try {
      paragraphs.push(new Paragraph({ text: '', pageBreakBefore: true }));
      paragraphs.push(
        new Paragraph({
          text: 'Geographical Map',
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 },
        }),
      );

      if (imageCache && imageCache.has(mapImage.url)) {
        imageBuffer = imageCache.get(mapImage.url)!;
        this.logger.debug(
          `✓ Using cached map: ${mapImage.url.substring(mapImage.url.lastIndexOf('/') + 1)}`,
        );
      } else {
        this.logger.warn(
          `⚠ Map not in cache, downloading: ${mapImage.url.substring(mapImage.url.lastIndexOf('/') + 1)}`,
        );
        imageBuffer = await this.downloadImageWithRetry(mapImage.url);
      }

      const imageType = this.getImageType(mapImage.mimeType || mapImage.url);
      const widthInEMU = Math.round(3.97 * 914400);
      const heightInEMU = Math.round(5.85 * 914400);

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
      if (!imageCache || !imageCache.has(mapImage.url)) {
        imageBuffer = null;
      }
      this.forceGC();
    }

    return paragraphs;
  }

  // Helper methods remain the same...
  private createTitlePage(
    title: string,
    subtitle: string,
    author: string,
  ): Paragraph[] {
    return [
      new Paragraph({
        text: title.toUpperCase(),
        alignment: AlignmentType.CENTER,
        spacing: { before: 1440, after: 400 },
        children: [
          new TextRun({ text: title.toUpperCase(), bold: true, size: 64 }),
        ],
      }),
      new Paragraph({
        text: subtitle,
        alignment: AlignmentType.CENTER,
        spacing: { after: 800 },
        children: [new TextRun({ text: subtitle, size: 36 })],
      }),
      new Paragraph({
        text: 'By',
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: 'By', size: 32 })],
      }),
      new Paragraph({
        text: author.toUpperCase(),
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
        children: [
          new TextRun({ text: author.toUpperCase(), bold: true, size: 32 }),
        ],
      }),
    ];
  }

  private createCopyrightPage(content: string): Paragraph[] {
    const cleanedContent = this.cleanContent(content);
    return [
      new Paragraph({ text: '', pageBreakBefore: true }),
      new Paragraph({
        children: [new TextRun({ text: cleanedContent, size: 18 })],
        spacing: { after: 200 },
      }),
    ];
  }

  private createAboutPage(content: string): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    paragraphs.push(new Paragraph({ text: '', pageBreakBefore: true }));
    paragraphs.push(
      new Paragraph({
        text: 'About Book',
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 300 },
      }),
    );

    const cleanedContent = this.cleanContent(content);
    const sections = cleanedContent.split('\n\n').filter((p) => p.trim());

    sections.forEach((section) => {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: section.trim(), size: 22 })],
          spacing: { after: 200 },
          alignment: AlignmentType.LEFT,
        }),
      );
    });

    return paragraphs;
  }

  private createTableOfContents(content: string): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    paragraphs.push(new Paragraph({ text: '', pageBreakBefore: true }));
    paragraphs.push(
      new Paragraph({
        text: 'Table of Contents',
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 300 },
      }),
    );

    const cleanedContent = this.cleanContent(content);
    const lines = cleanedContent.split('\n').filter((l) => l.trim());

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        paragraphs.push(new Paragraph({ text: '', spacing: { after: 100 } }));
        return;
      }

      if (trimmed.match(/^Chapter \d+$/)) {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: trimmed, bold: true, size: 22 })],
            spacing: { before: 200, after: 100 },
          }),
        );
      } else if (!trimmed.startsWith(' ')) {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: trimmed, size: 22 })],
            spacing: { after: 100 },
          }),
        );
      } else if (trimmed.match(/^[A-Z]/)) {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: '  ' + trimmed.trim(), size: 20 })],
            spacing: { after: 50 },
          }),
        );
      } else {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: '    ' + trimmed.trim(), size: 18 }),
            ],
            spacing: { after: 50 },
          }),
        );
      }
    });

    return paragraphs;
  }

  private createFormattedContent(content: string): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    const cleanedContent = this.cleanContent(content);
    const sections = cleanedContent.split('\n\n').filter((p) => p.trim());

    sections.forEach((section) => {
      const trimmed = section.trim();
      const isHeader =
        trimmed.length < 100 &&
        !trimmed.includes('.') &&
        trimmed.split(' ').length <= 10;

      if (isHeader) {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: trimmed, bold: true, size: 28 })],
            spacing: { before: 300, after: 240 },
            alignment: AlignmentType.LEFT,
          }),
        );
      } else {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: trimmed, size: 22 })],
            spacing: { after: 200 },
            alignment: AlignmentType.LEFT,
          }),
        );
      }
    });

    return paragraphs;
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
