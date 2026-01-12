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

  async generateDOCXBuffer(
    title: string,
    subtitle: string,
    author: string,
    chapters: any[],
    images: any[] = [],
  ): Promise<{ buffer: Buffer; filename: string }> {
    let doc: Document | null = null;
    let sections: Paragraph[] = [];

    try {
      this.logMemory('DOCX Start');

      const filename = `${this.sanitizeFilename(title)}_${Date.now()}.docx`;

      // TITLE PAGE
      const titlePageSections = this.createTitlePage(title, subtitle, author);

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

        // Clean the chapter title
        const cleanTitle = this.cleanText(chapter.title);

        sections.push(
          new Paragraph({
            text: '',
            pageBreakBefore: true,
          }),
        );

        // Chapter number - centered, smaller
        sections.push(
          new Paragraph({
            text: `Chapter ${chapterNumber}`,
            alignment: AlignmentType.CENTER,
            spacing: { before: 240, after: 240 },
            children: [
              new TextRun({
                text: `Chapter ${chapterNumber}`,
                size: 32, // 16pt
              }),
            ],
          }),
        );

        // Chapter title - centered, larger, bold (CLEANED)
        sections.push(
          new Paragraph({
            text: cleanTitle,
            alignment: AlignmentType.CENTER,
            spacing: { after: 600 },
            children: [
              new TextRun({
                text: cleanTitle,
                bold: true,
                size: 40, // 20pt
              }),
            ],
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

      // Create document
      doc = new Document({
        sections: [
          {
            properties: {
              page: {
                size: {
                  width: 8640,
                  height: 12960,
                },
                margin: {
                  top: 1656,
                  bottom: 1656,
                  left: 1440,
                  right: 1440,
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

      // Generate buffer instead of writing to file
      const buffer = await Packer.toBuffer(doc);

      this.logger.log(`DOCX generated: ${filename} (${buffer.length} bytes)`);
      this.logMemory('DOCX Complete');

      return {
        buffer,
        filename,
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
        spacing: { after: 800 },
        children: [
          new TextRun({
            text: subtitle,
            size: 36,
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
    // Clean the content
    const cleanedContent = this.cleanContent(content);

    return [
      new Paragraph({ text: '', pageBreakBefore: true }),
      new Paragraph({
        children: [
          new TextRun({
            text: cleanedContent,
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

    // Clean and split content
    const cleanedContent = this.cleanContent(content);
    const sections = cleanedContent.split('\n\n').filter((p) => p.trim());

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

    // Clean content first
    const cleanedContent = this.cleanContent(content);
    const lines = cleanedContent.split('\n').filter((l) => l.trim());

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

    // Clean the content
    const cleanedContent = this.cleanContent(content);
    const sections = cleanedContent.split('\n\n').filter((p) => p.trim());

    sections.forEach((section) => {
      const trimmed = section.trim();

      // Check if this is a section header
      const isHeader =
        trimmed.length < 100 &&
        !trimmed.includes('.') &&
        trimmed.split(' ').length <= 10;

      if (isHeader) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmed,
                bold: true,
                size: 28, // 14pt
              }),
            ],
            spacing: { before: 300, after: 240 },
            alignment: AlignmentType.LEFT,
          }),
        );
      } else {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmed,
                size: 22, // 11pt
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

    // Calculate optimal image positions
    const sections = this.createContentSections(
      textParagraphs,
      chapterImages.length,
    );

    for (const section of sections) {
      // Add text content
      if (section.paragraphs.length > 0) {
        const textContent = this.createFormattedContent(
          section.paragraphs.join('\n\n'),
        );
        paragraphs.push(...textContent);
      }

      // Add image if this section has one
      if (
        section.imageIndex !== undefined &&
        chapterImages[section.imageIndex]
      ) {
        const image = chapterImages[section.imageIndex];

        // Add spacing before image
        paragraphs.push(
          new Paragraph({
            text: '',
            spacing: { before: 400, after: 200 },
          }),
        );

        try {
          const imageParagraphs = await this.createImageParagraph(image);
          paragraphs.push(...imageParagraphs);
          imageParagraphs.length = 0;
        } catch (error) {
          this.logger.error(`Failed to insert image ${image.filename}:`, error);
        }

        // Add spacing after image
        paragraphs.push(
          new Paragraph({
            text: '',
            spacing: { before: 200, after: 400 },
          }),
        );
      }
    }

    return paragraphs;
  }

  /**
   * Helper method to intelligently split content into sections with images
   */
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

    // Calculate usable space
    const usableSpace = paragraphs.length - minParagraphsAfterImage;

    if (usableSpace < minParagraphsBeforeImage) {
      // Not enough space for proper placement
      sections.push({ paragraphs });
      return sections;
    }

    // Distribute images evenly
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

    // Add remaining paragraphs
    if (lastIndex < paragraphs.length) {
      sections.push({
        paragraphs: paragraphs.slice(lastIndex),
      });
    }

    return sections;
  }

  /**
   * Improved image paragraph creation with better spacing and optional caption
   */
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
      const widthInEMU = Math.round(3.98 * 914400);
      const heightInEMU = Math.round(2.53 * 914400);

      // Add the image
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
          spacing: { before: 300, after: 150 },
        }),
      );
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
          text: 'Geographical Map',
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
  // ============================================
  // SHARED HELPER METHOD (Add to both services)
  // ============================================

  /**
   * Clean markdown and special characters from text
   */
  private cleanText(text: string): string {
    if (!text) return '';

    return (
      text
        // Remove markdown bold (**text** or __text__)
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')

        // Remove markdown italic (*text* or _text_)
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/_(.+?)_/g, '$1')

        // Remove markdown headers (##, ###, etc.)
        .replace(/^#+\s+/gm, '')

        // Remove markdown strikethrough (~~text~~)
        .replace(/~~(.+?)~~/g, '$1')

        // Remove markdown code (`text`)
        .replace(/`(.+?)`/g, '$1')

        // Remove extra spaces created by removal
        .replace(/\s+/g, ' ')

        // Trim whitespace
        .trim()
    );
  }

  /**
   * Clean content with paragraph preservation
   */
  private cleanContent(content: string): string {
    if (!content) return '';

    // Split into paragraphs
    const paragraphs = content.split('\n\n');

    // Clean each paragraph
    const cleanedParagraphs = paragraphs
      .map((para) => this.cleanText(para))
      .filter((para) => para.length > 0);

    // Rejoin with double newlines
    return cleanedParagraphs.join('\n\n');
  }
}
