// src/queues/document-generation.queue.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DocumentType, Language } from '../DB/entities';

export interface DocumentJobData {
  projectId: string;
  type: DocumentType;
  language: Language;
  title: string;
  subtitle: string;
  author: string;
  includeImages: boolean;
}

@Injectable()
export class DocumentGenerationQueue {
  private readonly logger = new Logger(DocumentGenerationQueue.name);

  constructor(
    @InjectQueue('document-generation')
    private readonly docQueue: Queue<DocumentJobData>,
  ) {}

  async addDocumentJob(data: DocumentJobData): Promise<string> {
    this.logger.log(
      `Adding ${data.type} generation job for ${data.language}`,
    );

    try {
      const job = await this.docQueue.add('generate-document', data, {
        priority: 10,
        removeOnComplete: {
          age: 3600,
          count: 100,
        },
        removeOnFail: false,
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      });

      this.logger.log(`Document job added: ${job.id}`);
      return job.id!;
    } catch (error) {
      this.logger.error(`Failed to add document job:`, error);
      throw error;
    }
  }

  async getJobStatus(jobId: string) {
    const job = await this.docQueue.getJob(jobId);

    if (!job) {
      return {
        status: 'not_found',
        message: 'Job not found',
      };
    }

    const state = await job.getState();

    return {
      jobId: job.id!,
      status: state,
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
    };
  }
}