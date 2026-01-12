// src/modules/document/pdf.service.ts (Updated)
import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import axios from 'axios';

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  /**
   * Generate PDF and return as Buffer (for Cloudinary upload)
   */
  async generatePDFBuffer(
    title: string,
    subtitle: string,
    author: string,
    chapters: any[],
    images: any[] = [],
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
          await this.addMapPage(doc, mapImage);
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

  // Keep all your existing helper methods (addTitlePage, addCopyrightPage, etc.)
  // They remain unchanged...

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

    // Clean and split content
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

    // Clean content first
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
    // Clean the title
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
    // Clean the content
    const cleanedContent = this.cleanContent(content);
    const sections = cleanedContent.split('\n\n').filter((p) => p.trim());

    sections.forEach((section, index) => {
      const trimmed = section.trim();

      // Check if this is a section header
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
    // Clean the content
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
  ): Promise<void> {
    const paragraphs = content.split('\n\n').filter((p) => p.trim());

    // Calculate optimal image positions
    const sections = this.createContentSections(
      paragraphs,
      chapterImages.length,
    );

    for (const section of sections) {
      // Add text content
      if (section.paragraphs.length > 0) {
        this.addFormattedContent(doc, section.paragraphs.join('\n\n'));
      }

      // Add image if this section has one
      if (
        section.imageIndex !== undefined &&
        chapterImages[section.imageIndex]
      ) {
        const image = chapterImages[section.imageIndex];

        try {
          // Add generous spacing before image
          doc.moveDown(2.5);

          // Check if we need a new page
          const imageHeight = 182.16;
          const totalSpaceNeeded = imageHeight + 80; // Image + margins

          if (
            doc.y + totalSpaceNeeded >
            doc.page.height - doc.page.margins.bottom
          ) {
            doc.addPage();
            doc.moveDown(1);
          }

          // Insert the image
          await this.insertImage(doc, image);

          // Add generous spacing after image
          doc.moveDown(2.5);
        } catch (error) {
          this.logger.error(`Failed to insert image ${image.filename}:`, error);
        }
      }
    }
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
   * Improved image insertion with border and better positioning
   */
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
      const imageWidth = 286.56;
      const imageHeight = 182.16;
      const xPosition = (doc.page.width - imageWidth) / 2;

      // Save current position
      const imageY = doc.y;

      // Draw subtle border
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

      // Insert image
      doc.image(imageBuffer, xPosition, imageY, {
        width: imageWidth,
        height: imageHeight,
      });

      // Move cursor past the image
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
  ): Promise<void> {
    let imageBuffer: Buffer | null = null;

    try {
      doc.fontSize(16).font('Helvetica-Bold').text('Geographical Map', {
        align: 'center',
      });
      doc.moveDown(2);

      const response = await axios.get(mapImage.url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024,
      });

      imageBuffer = Buffer.from(response.data, 'binary');
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
