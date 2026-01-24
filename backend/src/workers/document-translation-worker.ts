// src/workers/document-translation-worker.ts - FIXED DUPLICATE ISSUE
import * as dotenv from 'dotenv';
dotenv.config();

import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import {
  Project,
  Chapter,
  Translation,
  Document,
  Job,
  Image,
  User,
  DocumentType,
  Language,
  DocumentStatus,
  JobType,
  JobStatus,
} from '../DB/entities/index';

import { PdfService } from '../documents/pdf.service';
import { DocxService } from '../documents/docx.service';
import { CloudinaryDocumentService } from '../documents/cloudinary-document.service';
import { LibreTranslationService } from '../translation/google-translation.service';
import { RedisCacheService } from '../queues/cache/redis-cache.service';
import { ConfigService } from '@nestjs/config';

const log = {
  log: (msg: string) => console.log(`[${new Date().toISOString()}] LOG ${msg}`),
  error: (msg: string, err?: any) =>
    console.error(`[${new Date().toISOString()}] ERROR ${msg}`, err),
  warn: (msg: string) =>
    console.warn(`[${new Date().toISOString()}] WARN ${msg}`),
};

const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const DB_HOST = process.env.DB_HOST;
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_USERNAME = process.env.DB_USERNAME;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME;

log.log('🚀 Starting Document Translation Worker...');
log.log(`Redis: ${REDIS_HOST}:${REDIS_PORT}`);
log.log(`Database: ${DB_HOST}:${DB_PORT}/${DB_NAME}`);

const cloudinaryName = process.env.CLOUDINARY_CLOUD_NAME;
const cloudinaryKey = process.env.CLOUDINARY_API_KEY;
if (!cloudinaryName || !cloudinaryKey) {
  log.error('❌ Missing Cloudinary credentials!');
  process.exit(1);
}
log.log('✅ Cloudinary credentials loaded');

const connection = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null,
});

connection.on('connect', () => log.log('✅ Redis connected'));
connection.on('error', (err) => log.error('❌ Redis error:', err));

let dataSource: DataSource | null = null;

async function initializeDatabase() {
  if (dataSource?.isInitialized) return dataSource;

  dataSource = new DataSource({
    type: 'postgres',
    host: DB_HOST,
    port: DB_PORT,
    username: DB_USERNAME,
    password: DB_PASSWORD,
    database: DB_NAME,
    entities: [User, Project, Chapter, Translation, Document, Job, Image],
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();
  log.log('✅ Database connected');
  return dataSource;
}

const configService = new ConfigService(process.env);
const pdfService = new PdfService(configService);
const docxService = new DocxService(configService);
const cloudinaryService = new CloudinaryDocumentService(configService);
const translationService = new LibreTranslationService(configService);
const redisCache = new RedisCacheService(configService);

log.log('✅ Services initialized');

const worker = new Worker(
  'document-translation',
  async (job) => {
    const startMem = process.memoryUsage().heapUsed / 1024 / 1024;
    const { type, sourceLanguage, targetLanguage } = job.data;

    log.log(
      `[START] Translating ${type} from ${sourceLanguage} to ${targetLanguage} | Job ID: ${job.id} | Heap: ${Math.round(startMem)}MB`,
    );

    try {
      const db = await initializeDatabase();
      const projectRepo = db.getRepository(Project);
      const chapterRepo = db.getRepository(Chapter);
      const documentRepo = db.getRepository(Document);
      const jobRepo = db.getRepository(Job);

      const { projectId } = job.data;

      // ✅ CRITICAL FIX: Check if document already exists BEFORE starting
      const existingDoc = await documentRepo.findOne({
        where: {
          projectId,
          type,
          language: targetLanguage,
        },
      });

      if (existingDoc) {
        log.warn(
          `⚠️  Document already exists: ${type} in ${targetLanguage}. Skipping translation.`,
        );
        await job.updateProgress(100);
        return {
          documentId: existingDoc.id,
          filename: existingDoc.filename,
          url: existingDoc.url,
          skipped: true,
        };
      }

      // Create job record
      const jobRecord = jobRepo.create({
        projectId,
        type:
          type === DocumentType.PDF
            ? JobType.PDF_GENERATION
            : JobType.DOCX_GENERATION,
        status: JobStatus.IN_PROGRESS,
        progress: 0,
        startedAt: new Date(),
      });
      await jobRepo.save(jobRecord);

      // Get English document (source)
      log.log(`Finding ${sourceLanguage} ${type} document...`);
      const sourceDoc = await documentRepo.findOne({
        where: {
          projectId,
          type,
          language: sourceLanguage,
        },
      });

      if (!sourceDoc) {
        throw new Error(
          `Source document not found: ${type} in ${sourceLanguage}`,
        );
      }

      await job.updateProgress(10);

      // Get project data
      const project = await projectRepo.findOne({
        where: { id: projectId },
        relations: ['chapters', 'images'],
      });

      if (!project) {
        throw new Error(`Project ${projectId} not found`);
      }

      log.log(`Found project with ${project.chapters.length} chapters`);

      await job.updateProgress(20);

      // Translate metadata
      log.log(`Translating metadata to ${targetLanguage}...`);
      const translatedMetadata = await translationService.translateMetadata(
        project.title,
        project.subtitle,
        targetLanguage,
      );

      await job.updateProgress(30);

      // Translate chapters
      log.log(
        `Translating ${project.chapters.length} chapters to ${targetLanguage}...`,
      );

      const sortedChapters = [...project.chapters].sort(
        (a, b) => a.order - b.order,
      );

      const translatedChapters = await translationService.translateChapters(
        sortedChapters,
        targetLanguage,
        (current, total) => {
          const progress = 30 + Math.floor((current / total) * 40);
          job.updateProgress(progress);
        },
      );

      await job.updateProgress(70);

      // Generate translated document
      log.log(`Generating ${type} document in ${targetLanguage}...`);

      let result: { buffer: Buffer; filename: string };

      if (type === DocumentType.PDF) {
        result = await pdfService.generatePDFBuffer(
          translatedMetadata.title,
          translatedMetadata.subtitle,
          project.author,
          translatedChapters,
          project.images,
          redisCache,
        );
      } else {
        result = await docxService.generateDOCXBuffer(
          translatedMetadata.title,
          translatedMetadata.subtitle,
          project.author,
          translatedChapters,
          project.images,
          redisCache,
        );
      }

      log.log(
        `Document generated: ${result.filename} (${Math.round(result.buffer.length / 1024)}KB)`,
      );

      await job.updateProgress(80);

      // Upload to Cloudinary
      log.log(`Uploading to Cloudinary...`);
      const cloudinaryResult = await cloudinaryService.uploadDocument(
        result.buffer,
        result.filename,
      );

      log.log(`Uploaded: ${cloudinaryResult.url}`);

      await job.updateProgress(90);

      // ✅ DOUBLE CHECK: Verify document doesn't exist before saving
      const doubleCheck = await documentRepo.findOne({
        where: {
          projectId,
          type,
          language: targetLanguage,
        },
      });

      if (doubleCheck) {
        log.warn(
          `⚠️  Document was created during translation process. Using existing document.`,
        );
        jobRecord.status = JobStatus.COMPLETED;
        jobRecord.progress = 100;
        jobRecord.completedAt = new Date();
        jobRecord.result = {
          documentId: doubleCheck.id,
          filename: doubleCheck.filename,
          url: doubleCheck.url,
          note: 'Used existing document',
        };
        await jobRepo.save(jobRecord);

        await job.updateProgress(100);

        return {
          documentId: doubleCheck.id,
          filename: doubleCheck.filename,
          url: doubleCheck.url,
          skipped: true,
        };
      }

      // Save document record
      const document = documentRepo.create({
        projectId,
        type,
        language: targetLanguage,
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

      await job.updateProgress(100);

      const endMem = process.memoryUsage().heapUsed / 1024 / 1024;
      log.log(
        `[COMPLETE] ${type} to ${targetLanguage} | Heap: ${Math.round(endMem)}MB | Δ: ${Math.round(endMem - startMem)}MB`,
      );

      if (global.gc) {
        global.gc();
        const afterGC = process.memoryUsage().heapUsed / 1024 / 1024;
        log.log(`[GC] Heap after cleanup: ${Math.round(afterGC)}MB`);
      }

      return {
        documentId: document.id,
        filename: result.filename,
        url: cloudinaryResult.url,
      };
    } catch (error) {
      log.error(`Translation job failed:`, error);
      throw error;
    }
  },
  {
    connection,
    concurrency: 1,
    limiter: {
      max: 1,
      duration: 2000,
    },
  },
);

worker.on('completed', (job) => {
  log.log(`✅ Translation job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  log.error(`❌ Translation job ${job?.id} failed:`, err);
});

worker.on('active', (job) => {
  log.log(
    `🔄 Translation job ${job.id} active: ${job.data.type} to ${job.data.targetLanguage}`,
  );
});

log.log('🌍 Document Translation Worker ready and listening for jobs');

// Graceful shutdown
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.log(`${signal} received, closing worker...`);

  try {
    await worker.close();
    log.log('Worker closed');
  } catch (err) {
    log.error('Error closing worker:', err);
  }

  try {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
      log.log('Database connection closed');
    }
  } catch (err) {
    log.error('Error closing database:', err);
  }

  try {
    await connection.quit();
    log.log('Redis connection closed');
  } catch (err) {
    log.error('Error closing Redis:', err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
