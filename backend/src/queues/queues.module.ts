// src/queue/queue.module.ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
// import { BookGenerationQueue } from './queues/book-generation.queue';
// import { BookGenerationProcessor } from './processors/book-generation.processor';
// import { DocumentGenerationQueue } from './queues/document-generation.queue';
// import { DocumentGenerationProcessor } from './processors/document-generation.processor';
import { Project, Job, Chapter, Translation, Document } from '../DB/entities';
import { ContentModule } from '../content/content.module';
import { TranslationModule } from '../translation/translation.module';
import { DocumentModule } from '../documents/document.module';
import { ImageModule } from '../images/image.module';
import { BookGenerationQueue } from './book-generation.queue';
import { BookGenerationProcessor } from './book-generation.processor';

@Module({
  imports: [
    // Configure Bull with Redis
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST', '127.0.0.1'),
          port: config.get<number>('REDIS_PORT', 6380),
        },
        defaultJobOptions: {
          removeOnComplete: 100, // Keep last 100 completed
          removeOnFail: 500, // Keep last 500 failed
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        },
      }),
    }),

    // Register queues
    BullModule.registerQueue(
      {
        name: 'book-generation',
      },
      {
        name: 'document-generation',
      },
    ),

    TypeOrmModule.forFeature([Project, Job, Chapter, Translation, Document]),
    ContentModule,
    TranslationModule,
    DocumentModule,
    ImageModule,
  ],
  providers: [BookGenerationQueue, BookGenerationProcessor],
  exports: [BookGenerationQueue],
})
export class QueueModule {}
