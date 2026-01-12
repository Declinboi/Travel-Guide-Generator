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
  PageBreak,
  Tab,
  TabStopType,
  TabStopPosition,
} from 'docx';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

@Injectable()
export class DocxService {
  private readonly logger = new Logger(DocxService.name);
  private readonly storagePath: string;

  constructor(private configService: ConfigService) {
    this.storagePath =
      this.configService.get('STORAGE_PATH') || './storage/documents';

    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
  }

  async generateDOCX(
    title: string,
    subtitle: string,
    author: string,
    chapters: any[],
    images: any[] = [],
  ): Promise<{ filename: string; filepath: string; size: number }> {
    let doc: Document | null = null;
    let sections: Paragraph[] = [];

    try {
      this.logMemory('DOCX Start');

      const filename = `${this.sanitizeFilename(title)}_${Date.now()}.docx`;
      const filepath = path.join(this.storagePath, filename);

      // TITLE PAGE
      const titlePageSections = this.createTitlePage(title, subtitle, author);

      // BLANK PAGES
      const blankPage1 = [new Paragraph({ text: '', pageBreakBefore: true })];
      const blankPage2 = [new Paragraph({ text: '', pageBreakBefore: true })];

      // COPYRIGHT PAGE
      const copyrightChapter = chapters.find((c) =>
        c.title.toLowerCase().includes('copyright'),
      );
      const copyrightSections = copyrightChapter
        ? this.createCopyrightPage(copyrightChapter.content)
        : [];

      // ABOUT BOOK PAGE
      const aboutChapter = chapters.find((c) =>
        c.title.toLowerCase().includes('about'),
      );
      const aboutSections = aboutChapter
        ? this.createAboutPage(aboutChapter.content)
        : [];

      // TABLE OF CONTENTS
      const tocChapter = chapters.find((c) =>
        c.title.toLowerCase().includes('table'),
      );
      const tocSections = tocChapter
        ? this.createTableOfContents(tocChapter.content)
        : [];

      // Combine front matter
      sections.push(
        ...titlePageSections,
        ...blankPage1,
        ...blankPage2,
        ...copyrightSections,
        ...aboutSections,
        ...tocSections,
      );

      // MAIN CHAPTERS
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

        // Chapter title
        sections.push(
          new Paragraph({
            text: `Chapter ${chapterNumber}`,
            spacing: { before: 240, after: 120 },
            pageBreakBefore: true,
          }),
        );

        sections.push(
          new Paragraph({
            text: chapter.title,
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 400 },
          }),
        );

        const chapterImages = images
          .filter((img) => img.chapterNumber === chapterNumber && !img.isMap)
          .sort((a, b) => (a.position || 0) - (b.position || 0));

        if (chapterImages.length > 0) {
          const contentWithImages = await this.createContentWithImages(
            chapter.content,
            chapterImages,
          );
          sections.push(...contentWithImages);
          contentWithImages.length = 0;
        } else {
          sections.push(...this.createFormattedContent(chapter.content));
        }

        if (global.gc && i % 2 === 0) {
          global.gc();
        }
      }

      // MAP PAGE
      const mapImage = images.find((img) => img.isMap);
      if (mapImage) {
        const mapSections = await this.createMapPage(mapImage);
        sections.push(...mapSections);
        mapSections.length = 0;
      }

      // Create document with page numbers
      doc = new Document({
        sections: [
          {
            properties: {
              page: {
                size: {
                  width: 8640, // 6 inches
                  height: 12960, // 9 inches
                },
                margin: {
                  top: 720,
                  bottom: 720,
                  left: 720,
                  right: 720,
                },
                pageNumbers: {
                  start: 1,
                  formatType: NumberFormat.DECIMAL,
                },
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
            children: sections,
          },
        ],
      });

      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(filepath, buffer);

      const stats = fs.statSync(filepath);
      this.logger.log(`DOCX generated: ${filename} (${stats.size} bytes)`);

      this.logMemory('DOCX Complete');

      return {
        filename,
        filepath,
        size: stats.size,
      };
    } catch (error) {
      this.logger.error('Error generating DOCX:', error);
      throw error;
    } finally {
      doc = null;
      sections.length = 0;

      if (global.gc) {
        global.gc();
      }
    }
  }

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
          new TextRun({
            text: title.toUpperCase(),
            bold: true,
            size: 64,
          }),
        ],
      }),
      new Paragraph({
        text: subtitle,
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
        children: [
          new TextRun({
            text: subtitle,
            size: 36,
          }),
        ],
      }),
      new Paragraph({
        text: '2026',
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: '2026',
            size: 28,
          }),
        ],
      }),
      new Paragraph({
        text: '(Including a map at the Last Page)',
        alignment: AlignmentType.CENTER,
        spacing: { after: 800 },
        children: [
          new TextRun({
            text: '(Including a map at the Last Page)',
            italics: true,
            size: 22,
          }),
        ],
      }),
      new Paragraph({
        text: 'A practical roadmap with step-by-step plans for',
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
        children: [
          new TextRun({
            text: 'A practical roadmap with step-by-step plans for',
            size: 24,
          }),
        ],
      }),
      new Paragraph({
        text: 'every kind of traveler',
        alignment: AlignmentType.CENTER,
        spacing: { after: 800 },
        children: [
          new TextRun({
            text: 'every kind of traveler',
            size: 24,
          }),
        ],
      }),
      new Paragraph({
        text: 'By',
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: 'By',
            size: 32,
          }),
        ],
      }),
      new Paragraph({
        text: author.toUpperCase(),
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
        children: [
          new TextRun({
            text: author.toUpperCase(),
            bold: true,
            size: 32,
          }),
        ],
      }),
    ];
  }

  private createCopyrightPage(content: string): Paragraph[] {
    return [
      new Paragraph({ text: '', pageBreakBefore: true }),
      new Paragraph({
        children: [
          new TextRun({
            text: content,
            size: 18,
          }),
        ],
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

    const sections = content.split('\n\n').filter((p) => p.trim());

    sections.forEach((section) => {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: section.trim(),
              size: 22,
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

    paragraphs.push(new Paragraph({ text: '', pageBreakBefore: true }));

    paragraphs.push(
      new Paragraph({
        text: 'Table of Contents',
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 300 },
      }),
    );

    const lines = content.split('\n').filter((l) => l.trim());

    lines.forEach((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        paragraphs.push(
          new Paragraph({
            text: '',
            spacing: { after: 100 },
          }),
        );
        return;
      }

      // Chapter headers
      if (trimmed.match(/^Chapter \d+$/)) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmed,
                bold: true,
                size: 22,
              }),
            ],
            spacing: { before: 200, after: 100 },
          }),
        );
      }
      // Chapter titles
      else if (!trimmed.startsWith(' ')) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmed,
                size: 22,
              }),
            ],
            spacing: { after: 100 },
          }),
        );
      }
      // Sections
      else if (trimmed.match(/^[A-Z]/)) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: '  ' + trimmed.trim(),
                size: 20,
              }),
            ],
            spacing: { after: 50 },
          }),
        );
      }
      // Subsections
      else {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: '    ' + trimmed.trim(),
                size: 18,
              }),
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
    const sections = content.split('\n\n').filter((p) => p.trim());

    sections.forEach((section, index) => {
      const trimmed = section.trim();

      // Section headers
      if (trimmed.length < 100 && !trimmed.includes('.')) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmed,
                bold: true,
                size: 26,
              }),
            ],
            spacing: { before: 300, after: 200 },
          }),
        );
      }
      // Regular paragraphs
      else {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmed,
                size: 22,
              }),
            ],
            spacing: { after: 200 },
            alignment: AlignmentType.LEFT,
          }),
        );
      }
    });

    return paragraphs;
  }

  private async createContentWithImages(
    content: string,
    chapterImages: any[],
  ): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];
    const textParagraphs = content.split('\n\n').filter((p) => p.trim());
    const sectionsPerImage = Math.floor(
      textParagraphs.length / (chapterImages.length + 1),
    );

    let currentIndex = 0;

    for (let i = 0; i < chapterImages.length; i++) {
      const image = chapterImages[i];

      const textSection = textParagraphs.slice(
        currentIndex,
        currentIndex + sectionsPerImage,
      );
      paragraphs.push(...this.createFormattedContent(textSection.join('\n\n')));

      try {
        const imageParagraphs = await this.createImageParagraph(image);
        paragraphs.push(...imageParagraphs);
        imageParagraphs.length = 0;
      } catch (error) {
        this.logger.error(`Failed to insert image ${image.filename}:`, error);
      }

      currentIndex += sectionsPerImage;
    }

    const remainingText = textParagraphs.slice(currentIndex);
    paragraphs.push(...this.createFormattedContent(remainingText.join('\n\n')));

    return paragraphs;
  }

  private async createImageParagraph(image: any): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];
    let imageBuffer: Buffer | null = null;

    try {
      const response = await axios.get(image.url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024,
      });

      imageBuffer = Buffer.from(response.data, 'binary');
      const imageType = this.getImageType(image.mimeType || image.url);

      // Image dimensions: 3.98 inches width x 2.53 inches height
      // In EMUs (English Metric Units): 1 inch = 914,400 EMUs
      const widthInEMU = Math.round(3.98 * 914400); // 3,639,312 EMUs
      const heightInEMU = Math.round(2.53 * 914400); // 2,313,432 EMUs

      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: imageBuffer,
              type: imageType,
              transformation: {
                width: widthInEMU,
                height: heightInEMU,
              },
            }),
          ],
          spacing: { before: 200, after: 100 },
        }),
      );

      if (image.caption) {
        paragraphs.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: image.caption,
                italics: true,
                size: 18,
              }),
            ],
            spacing: { after: 400 },
          }),
        );
      }
    } catch (error) {
      this.logger.error('Error creating image paragraph:', error);
    } finally {
      imageBuffer = null;

      if (global.gc) {
        global.gc();
      }
    }

    return paragraphs;
  }

  private async createMapPage(mapImage: any): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];
    let imageBuffer: Buffer | null = null;

    try {
      paragraphs.push(new Paragraph({ text: '', pageBreakBefore: true }));

      paragraphs.push(
        new Paragraph({
          text: 'Geographical Map of Trieste',
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 },
        }),
      );

      const response = await axios.get(mapImage.url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024,
      });

      imageBuffer = Buffer.from(response.data, 'binary');
      const imageType = this.getImageType(mapImage.mimeType || mapImage.url);

      // Map dimensions: 3.97 inches width x 5.85 inches height
      // In EMUs (English Metric Units): 1 inch = 914,400 EMUs
      const widthInEMU = Math.round(3.97 * 914400); // 3,630,168 EMUs
      const heightInEMU = Math.round(5.85 * 914400); // 5,349,240 EMUs

      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: imageBuffer,
              type: imageType,
              transformation: {
                width: widthInEMU,
                height: heightInEMU,
              },
            }),
          ],
        }),
      );
    } catch (error) {
      this.logger.error('Error creating map image:', error);
    } finally {
      imageBuffer = null;

      if (global.gc) {
        global.gc();
      }
    }

    return paragraphs;
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

  private logMemory(label: string): void {
    const used = process.memoryUsage();
    this.logger.log(
      `[${label}] Heap: ${Math.round(used.heapUsed / 1024 / 1024)} MB | RSS: ${Math.round(used.rss / 1024 / 1024)} MB`,
    );
  }

  async deleteDOCX(filepath: string): Promise<void> {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      this.logger.log(`DOCX deleted: ${filepath}`);
    }
  }
}
