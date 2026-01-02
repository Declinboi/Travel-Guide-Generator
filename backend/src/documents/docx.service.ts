import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from 'docx';
import * as fs from 'fs';
import * as path from 'path';

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
          text: `By ${author}`,
          alignment: AlignmentType.CENTER,
          spacing: { after: 1200 },
        }),
      );

      // Page break
      sections.push(
        new Paragraph({
          text: '',
          pageBreakBefore: true,
        }),
      );

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

      // Main Chapters
      const mainChapters = chapters
        .filter(
          (c) =>
            !['title', 'copyright', 'about', 'table'].some((keyword) =>
              c.title.toLowerCase().includes(keyword),
            ),
        )
        .sort((a, b) => a.order - b.order);

      mainChapters.forEach((chapter, index) => {
        sections.push(
          new Paragraph({
            text: chapter.title,
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 400 },
          }),
        );

        sections.push(...this.contentToParagraphs(chapter.content));

        if (index < mainChapters.length - 1) {
          sections.push(new Paragraph({ text: '', pageBreakBefore: true }));
        }
      });

      const doc = new Document({
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
              },
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

  private contentToParagraphs(content: string): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    const lines = content.split('\n\n');

    lines.forEach((line) => {
      if (line.trim()) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: line.trim(),
                size: 22, // 11pt
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
