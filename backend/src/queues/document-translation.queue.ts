import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DocumentType, Language } from '../DB/entities';

export interface DocumentTranslationJobData {
  projectId: string;
  type: DocumentType;
  sourceLanguage: Language;
  targetLanguage: Language;
}

@Injectable()
export class DocumentTranslationQueue {
  private readonly logger = new Logger(DocumentTranslationQueue.name);

  constructor(
    @InjectQueue('document-translation')
    private readonly translationQueue: Queue<DocumentTranslationJobData>,
  ) {}

  async addTranslationJob(data: DocumentTranslationJobData): Promise<string> {
    this.logger.log(
      `Adding translation job: ${data.type} from ${data.sourceLanguage} to ${data.targetLanguage}`,
    );

    try {
      const job = await this.translationQueue.add('translate-document', data, {
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

      this.logger.log(`Translation job added: ${job.id}`);
      return job.id!;
    } catch (error) {
      this.logger.error(`Failed to add translation job:`, error);
      throw error;
    }
  }

  async getJobStatus(jobId: string) {
    const job = await this.translationQueue.getJob(jobId);

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