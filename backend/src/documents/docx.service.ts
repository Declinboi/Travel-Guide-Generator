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
    try {
      const filename = `${this.sanitizeFilename(title)}_${Date.now()}.docx`;
      const filepath = path.join(this.storagePath, filename);

      const sections: any[] = [];

      // Title Page
      sections.push(
        new Paragraph({
          text: title,
          heading: HeadingLevel.TITLE,
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 },
        }),
      );

      if (subtitle) {
        sections.push(
          new Paragraph({
            text: subtitle,
            alignment: AlignmentType.CENTER,
            spacing: { after: 600 },
          }),
        );
      }

      sections.push(
        new Paragraph({
          text: '(Including a map at the Last Page)',
          alignment: AlignmentType.CENTER,
          spacing: { after: 600 },
        }),
      );

      sections.push(
        new Paragraph({
          text: `By ${author}`,
          alignment: AlignmentType.CENTER,
          spacing: { after: 600 },
        }),
      );

      sections.push(new Paragraph({ text: '', pageBreakBefore: true }));

      // Copyright
      const copyrightChapter = chapters.find((c) =>
        c.title.toLowerCase().includes('copyright'),
      );
      if (copyrightChapter) {
        sections.push(...this.contentToParagraphs(copyrightChapter.content));
        sections.push(new Paragraph({ text: '', pageBreakBefore: true }));
      }

      // About Book
      const aboutChapter = chapters.find((c) =>
        c.title.toLowerCase().includes('about'),
      );
      if (aboutChapter) {
        sections.push(
          new Paragraph({
            text: 'About This Book',
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 300 },
          }),
        );
        sections.push(...this.contentToParagraphs(aboutChapter.content));
        sections.push(new Paragraph({ text: '', pageBreakBefore: true }));
      }

      // Table of Contents
      const tocChapter = chapters.find((c) =>
        c.title.toLowerCase().includes('table'),
      );
      if (tocChapter) {
        sections.push(
          new Paragraph({
            text: 'Table of Contents',
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 300 },
          }),
        );
        sections.push(...this.contentToParagraphs(tocChapter.content));
        sections.push(new Paragraph({ text: '', pageBreakBefore: true }));
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
          const contentWithImages = await this.insertImagesInContent(
            chapter.content,
            chapterImages,
          );
          sections.push(...contentWithImages);
        } else {
          sections.push(...this.contentToParagraphs(chapter.content));
        }

        if (i < mainChapters.length - 1) {
          sections.push(new Paragraph({ text: '', pageBreakBefore: true }));
        }
      }

      // Add Map on Last Page
      const mapImage = images.find((img) => img.isMap);
      if (mapImage) {
        sections.push(new Paragraph({ text: '', pageBreakBefore: true }));
        const mapParagraph = await this.createFullPageImage(mapImage);
        sections.push(...mapParagraph);
      }

      const doc = new Document({
        sections: [
          {
            properties: {
              page: {
                size: {
                  width: 8640,
                  height: 12960,
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

      return {
        filename,
        filepath,
        size: stats.size,
      };
    } catch (error) {
      this.logger.error('Error generating DOCX:', error);
      throw error;
    }
  }

  private async insertImagesInContent(
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
      paragraphs.push(...this.textToParagraphs(textSection));

      try {
        const imageParagraphs = await this.createImageParagraph(image);
        paragraphs.push(...imageParagraphs);
      } catch (error) {
        this.logger.error(`Failed to insert image ${image.filename}:`, error);
      }

      currentIndex += sectionsPerImage;
    }

    const remainingText = textParagraphs.slice(currentIndex);
    paragraphs.push(...this.textToParagraphs(remainingText));

    return paragraphs;
  }

  private async createImageParagraph(image: any): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];

    try {
      const response = await axios.get(image.url, {
        responseType: 'arraybuffer',
      });
      const imageBuffer = Buffer.from(response.data, 'binary');
      const imageType = this.getImageType(image.mimeType || image.url);

      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: imageBuffer,
              type: imageType,
              transformation: {
                width: 480,
                height: 320,
              },
            }),
          ],
          spacing: { before: 200, after: 200 },
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
    }

    return paragraphs;
  }

  private async createFullPageImage(mapImage: any): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];

    try {
      const response = await axios.get(mapImage.url, {
        responseType: 'arraybuffer',
      });
      const imageBuffer = Buffer.from(response.data, 'binary');
      const imageType = this.getImageType(mapImage.mimeType || mapImage.url);

      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: imageBuffer,
              type: imageType,
              transformation: {
                width: 576,
                height: 864,
              },
            }),
          ],
        }),
      );

      if (mapImage.caption) {
        paragraphs.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: mapImage.caption,
                size: 20,
              }),
            ],
            spacing: { before: 200 },
          }),
        );
      }
    } catch (error) {
      this.logger.error('Error creating map image:', error);
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

  private contentToParagraphs(content: string): Paragraph[] {
    const lines = content.split('\n\n');
    return this.textToParagraphs(lines);
  }

  private textToParagraphs(lines: string[]): Paragraph[] {
    const paragraphs: Paragraph[] = [];

    lines.forEach((line) => {
      if (line.trim()) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: line.trim(),
                size: 22,
              }),
            ],
            spacing: { after: 200 },
          }),
        );
      }
    });

    return paragraphs;
  }

  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[^a-z0-9]/gi, '_')
      .replace(/_+/g, '_')
      .toLowerCase();
  }

  async deleteDOCX(filepath: string): Promise<void> {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      this.logger.log(`DOCX deleted: ${filepath}`);
    }
  }
}
