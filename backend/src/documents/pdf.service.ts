import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private readonly storagePath: string;

  constructor(private configService: ConfigService) {
    this.storagePath = this.configService.get('STORAGE_PATH') || './storage/documents';
    
    // Create storage directory if it doesn't exist
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
  }

  async generatePDF(
    title: string,
    subtitle: string,
    author: string,
    chapters: any[],
    images: any[] = [],
  ): Promise<{ filename: string; filepath: string; size: number }> {
    return new Promise((resolve, reject) => {
      try {
        const filename = `${this.sanitizeFilename(title)}_${Date.now()}.pdf`;
        const filepath = path.join(this.storagePath, filename);

        // 6x9 inches = 432x648 points (72 points per inch)
        const doc = new PDFDocument({
          size: [432, 648],
          margins: { top: 36, bottom: 36, left: 36, right: 36 },
          info: {
            Title: title,
            Author: author,
          },
        });

        const writeStream = fs.createWriteStream(filepath);
        doc.pipe(writeStream);

        // Title Page
        doc.fontSize(28).font('Helvetica-Bold').text(title, { align: 'center' });
        doc.moveDown();
        
        if (subtitle) {
          doc.fontSize(16).font('Helvetica').text(subtitle, { align: 'center' });
          doc.moveDown(2);
        }

        doc.fontSize(14).text(`By ${author}`, { align: 'center' });
        doc.addPage();

        // Copyright Page
        const copyrightChapter = chapters.find(c => c.title.toLowerCase().includes('copyright'));
        if (copyrightChapter) {
          doc.fontSize(10).font('Helvetica').text(copyrightChapter.content);
          doc.addPage();
        }

        // About Book
        const aboutChapter = chapters.find(c => c.title.toLowerCase().includes('about'));
        if (aboutChapter) {
          doc.fontSize(16).font('Helvetica-Bold').text('About This Book');
          doc.moveDown();
          doc.fontSize(11).font('Helvetica').text(aboutChapter.content, { align: 'justify' });
          doc.addPage();
        }

        // Table of Contents
        const tocChapter = chapters.find(c => c.title.toLowerCase().includes('table'));
        if (tocChapter) {
          doc.fontSize(20).font('Helvetica-Bold').text('Table of Contents');
          doc.moveDown();
          doc.fontSize(11).font('Helvetica').text(tocChapter.content);
          doc.addPage();
        }

        // Main Chapters
        const mainChapters = chapters
          .filter(c => !['title', 'copyright', 'about', 'table'].some(
            keyword => c.title.toLowerCase().includes(keyword)
          ))
          .sort((a, b) => a.order - b.order);

        mainChapters.forEach((chapter, index) => {
          // Chapter Title
          doc.fontSize(22).font('Helvetica-Bold').text(chapter.title);
          doc.moveDown(1.5);

          // Chapter Content
          const content = this.formatContentForPDF(chapter.content);
          doc.fontSize(11).font('Helvetica').text(content, {
            align: 'justify',
            lineGap: 5,
          });

          // Add page break if not last chapter
          if (index < mainChapters.length - 1) {
            doc.addPage();
          }
        });

        // Finalize PDF
        doc.end();

        writeStream.on('finish', () => {
          const stats = fs.statSync(filepath);
          this.logger.log(`PDF generated: ${filename} (${stats.size} bytes)`);
          
          resolve({
            filename,
            filepath,
            size: stats.size,
          });
        });

        writeStream.on('error', reject);

      } catch (error) {
        this.logger.error('Error generating PDF:', error);
        reject(error);
      }
    });
  }

  private formatContentForPDF(content: string): string {
    // Remove extra whitespace and format for better PDF readability
    return content
      .replace(/\n\n\n+/g, '\n\n')
      .replace(/\t/g, '    ')
      .trim();
  }

  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[^a-z0-9]/gi, '_')
      .replace(/_+/g, '_')
      .toLowerCase();
  }

  async deletePDF(filepath: string): Promise<void> {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      this.logger.log(`PDF deleted: ${filepath}`);
    }
  }
}
