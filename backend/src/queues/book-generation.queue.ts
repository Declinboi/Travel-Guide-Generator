// src/queue/queues/book-generation.queue.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { CreateBookDto } from 'src/book gen/create-book.dto';

export interface SerializedFile {
  buffer: {
    type: 'Buffer';
    data: number[];
  };
  originalname: string;
  mimetype: string;
}

export interface BookGenerationJobData {
  projectId: string;
  createBookDto: CreateBookDto;
  files: {
    images?: SerializedFile[];
    mapImage?: SerializedFile[];
  };
}

@Injectable()
export class BookGenerationQueue {
  private readonly logger = new Logger(BookGenerationQueue.name);

  constructor(
    @InjectQueue('book-generation')
    private readonly bookQueue: Queue<BookGenerationJobData>,
  ) {}

  /**
   * Add a book generation job to the queue
   */
  async addBookGenerationJob(data: BookGenerationJobData): Promise<string> {
    this.logger.log(`Adding book generation job for project: ${data.projectId}`);

    const job = await this.bookQueue.add('generate-book', data, {
      priority: 10,
      removeOnComplete: true,
      removeOnFail: false, // Keep failed jobs for debugging
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
    });

    this.logger.log(`Book generation job added: ${job.id}`);
    return job.id!;
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string) {
    const job = await this.bookQueue.getJob(jobId);

    if (!job) {
      return {
        status: 'not_found',
        message: 'Job not found',
      };
    }

    const state = await job.getState();
    const progress = job.progress;

    return {
      jobId: job.id!,
      status: state,
      progress: typeof progress === 'object' ? progress : { percent: progress },
      data: job.data,
      result: job.returnvalue,
      failedReason: job.failedReason,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
    };
  }

  /**
   * Get queue metrics
   */
  async getQueueMetrics() {
    const [waiting, active, completed, failed] = await Promise.all([
      this.bookQueue.getWaitingCount(),
      this.bookQueue.getActiveCount(),
      this.bookQueue.getCompletedCount(),
      this.bookQueue.getFailedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      total: waiting + active + completed + failed,
    };
  }
}