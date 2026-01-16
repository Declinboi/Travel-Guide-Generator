// src/workers/document-worker.ts - RUN AS SEPARATE PROCESS
import { Worker } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'typeorm';
import Redis from 'ioredis';
import { Project, Chapter, Translation, Document, Job } from '../DB/entities';
import { DocumentType, Language, DocumentStatus, JobType, JobStatus } from '../DB/entities';
import { PdfService } from 'src/documents/pdf.service';
import { DocxService } from 'src/documents/docx.service';
import { CloudinaryDocumentService } from 'src/documents/cloudinary-document.service';
import { RedisCacheService } from './cache/redis-cache.service';

// Bootstrap configuration
const configService = new ConfigService();
const logger = new Logger('DocumentWorker');

// Redis connection for BullMQ
const redisHost = configService.get('REDIS_HOST', '127.0.0.1');
const redisPort = configService.get<number>('REDIS_PORT', 6380);

const connection = new Redis({
  host: redisHost,
  port: redisPort,
  maxRetriesPerRequest: null,
});

// Create services
const pdfService = new PdfService(configService);
const docxService = new DocxService(configService);
const cloudinaryService = new CloudinaryDocumentService(configService);
const redisCache = new RedisCacheService(configService);

// Database connection
let dbConnection: any = null;

async function initializeDatabase() {
  if (dbConnection) return dbConnection;

  dbConnection = await createConnection({
    type: 'postgres',
    host: configService.get('DB_HOST', 'localhost'),
    port: configService.get<number>('DB_PORT', 5433),
    username: configService.get('DB_USERNAME', 'travel'),
    password: configService.get('DB_PASSWORD', 'travelpass'),
    database: configService.get('DB_NAME', 'travel_guides'),
    entities: [Project, Chapter, Translation, Document, Job],
    synchronize: false,
  });

  logger.log('✅ Database connected');
  return dbConnection;
}

// Worker processor
const worker = new Worker(
  'document-generation',
  async (job) => {
    const startMem = process.memoryUsage().heapUsed / 1024 / 1024;
    logger.log(`[START] ${job.data.type}-${job.data.language} | Heap: ${Math.round(startMem)}MB`);

    try {
      // Initialize DB connection
      const db = await initializeDatabase();
      
      const projectRepo = db.getRepository(Project);
      const chapterRepo = db.getRepository(Chapter);
      const translationRepo = db.getRepository(Translation);
      const documentRepo = db.getRepository(Document);
      const jobRepo = db.getRepository(Job);

      const { projectId, type, language, title, subtitle, author, includeImages } = job.data;

      // Get project data
      const project = await projectRepo.findOne({
        where: { id: projectId },
        relations: ['chapters', 'images'],
      });

      if (!project) {
        throw new Error(`Project ${projectId} not found`);
      }

      // Create job record
      const jobRecord = jobRepo.create({
        projectId,
        type: type === DocumentType.PDF ? JobType.PDF_GENERATION : JobType.DOCX_GENERATION,
        status: JobStatus.IN_PROGRESS,
        progress: 0,
        startedAt: new Date(),
      });
      await jobRepo.save(jobRecord);

      // Get content
      let chapters = [...project.chapters];
      let finalTitle = title || project.title;
      let finalSubtitle = subtitle || project.subtitle;

      if (language !== Language.ENGLISH) {
        const translation = await translationRepo.findOne({
          where: { projectId, language },
        });

        if (translation) {
          finalTitle = translation.title;
          finalSubtitle = translation.subtitle;
          const translatedChapters = translation.content as any[];
          chapters = chapters.map((ch, index) => ({
            ...ch,
            content: translatedChapters[index]?.content || ch.content,
            title: translatedChapters[index]?.title || ch.title,
          }));
        }
      }

      await job.updateProgress(20);

      // Generate document
      logger.log(`Generating ${type} for ${finalTitle} in ${language}...`);
      
      let result: { buffer: Buffer; filename: string };

      if (type === DocumentType.PDF) {
        result = await pdfService.generatePDFBuffer(
          finalTitle,
          finalSubtitle,
          author,
          chapters,
          includeImages ? project.images : [],
          redisCache,
        );
      } else {
        result = await docxService.generateDOCXBuffer(
          finalTitle,
          finalSubtitle,
          author,
          chapters,
          includeImages ? project.images : [],
          redisCache,
        );
      }

      await job.updateProgress(50);

      // Upload to Cloudinary
      logger.log(`Uploading ${result.filename}...`);
      const cloudinaryResult = await cloudinaryService.uploadDocument(
        result.buffer,
        result.filename,
      );

      await job.updateProgress(80);

      // Save document record
      const document = documentRepo.create({
        projectId,
        type,
        language,
        filename: result.filename,
        url: cloudinaryResult.url,
        storageKey: cloudinaryResult.publicId,
        size: cloudinaryResult.size,
        status: DocumentStatus.COMPLETED,
      });
      await documentRepo.save(document);

      // Complete job
      jobRecord.status = JobStatus.COMPLETED;
      jobRecord.progress = 100;
      jobRecord.completedAt = new Date();
      jobRecord.result = {
        documentId: document.id,
        filename: result.filename,
        url: cloudinaryResult.url,
      };
      await jobRepo.save(jobRecord);

      const endMem = process.memoryUsage().heapUsed / 1024 / 1024;
      logger.log(`[COMPLETE] ${type}-${language} | Heap: ${Math.round(endMem)}MB | Δ: ${Math.round(endMem - startMem)}MB`);

      // Force GC
      if (global.gc) {
        global.gc();
        const afterGC = process.memoryUsage().heapUsed / 1024 / 1024;
        logger.log(`[GC] Heap after cleanup: ${Math.round(afterGC)}MB`);
      }

      return {
        documentId: document.id,
        filename: result.filename,
        url: cloudinaryResult.url,
      };
    } catch (error) {
      logger.error(`Job failed:`, error);
      throw error;
    }
  },
  {
    connection,
    concurrency: 1, // ONE document at a time per worker
    limiter: {
      max: 1,
      duration: 2000,
    },
  },
);

worker.on('completed', (job) => {
  logger.log(`✅ Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  logger.error(`❌ Job ${job?.id} failed:`, err.message);
});

worker.on('active', (job) => {
  logger.log(`🔄 Job ${job.id} active`);
});

logger.log('📄 Document Worker started');

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.log('SIGTERM received, closing worker...');
  await worker.close();
  if (dbConnection) await dbConnection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.log('SIGINT received, closing worker...');
  await worker.close();
  if (dbConnection) await dbConnection.close();
  process.exit(0);
});