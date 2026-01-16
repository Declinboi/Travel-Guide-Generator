import {
  Module,
  OnModuleInit,
  Logger,
  Injectable,
  forwardRef,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project, Job, Chapter, Translation, Document } from '../DB/entities';
import { ContentModule } from '../content/content.module';
import { TranslationModule } from '../translation/translation.module';
import { DocumentModule } from '../documents/document.module';
import { ImageModule } from '../images/image.module';
import { BookGenerationQueue } from './book-generation.queue';
import { BookGenerationProcessor } from './book-generation.processor';
import Redis from 'ioredis';
import { RedisCacheService } from './cache/redis-cache.service';
import { DocumentGenerationQueue } from './document-generation.queue';

// Redis Monitoring Service - MOVED BEFORE QueueModule
@Injectable()
class RedisMonitorService {
  private readonly logger = new Logger('RedisMonitor');
  private redisClient: Redis;
  private isMonitoring = false;

  constructor(private readonly configService: ConfigService) {}

  async startMonitoring() {
    if (this.isMonitoring) return;

    const redisHost = this.configService.get('REDIS_HOST', '127.0.0.1');
    const redisPort = this.configService.get<number>('REDIS_PORT', 6380);

    this.redisClient = new Redis({
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.redisClient.on('connect', () => {
      this.logger.log('✅ Redis connected successfully');
    });

    this.redisClient.on('ready', () => {
      this.logger.log('✅ Redis is ready to accept commands');
      this.isMonitoring = true;
    });

    this.redisClient.on('error', (err) => {
      this.logger.error('❌ Redis connection error:', err.message);
    });

    this.redisClient.on('close', () => {
      this.logger.warn('⚠️  Redis connection closed');
    });

    this.redisClient.on('reconnecting', () => {
      this.logger.log('🔄 Redis reconnecting...');
    });

    this.redisClient.on('end', () => {
      this.logger.warn('⚠️  Redis connection ended');
      this.isMonitoring = false;
    });

    // Test connection
    try {
      await this.redisClient.ping();
      this.logger.log('✅ Redis PING successful');
    } catch (error) {
      this.logger.error('❌ Redis PING failed:', error);
    }

    // Monitor Redis memory every 30 seconds
    setInterval(async () => {
      try {
        const info = await this.redisClient.info('memory');
        const usedMemory = this.parseRedisInfo(info, 'used_memory_human');
        const peakMemory = this.parseRedisInfo(info, 'used_memory_peak_human');

        this.logger.debug(
          `📊 Redis Memory - Used: ${usedMemory}, Peak: ${peakMemory}`,
        );
      } catch (error) {
        this.logger.error('Failed to get Redis info:', error.message);
      }
    }, 30000);
  }

  private parseRedisInfo(info: string, key: string): string {
    const match = info.match(new RegExp(`${key}:(.+)`));
    return match ? match[1].trim() : 'unknown';
  }

  async getConnectionStatus(): Promise<boolean> {
    try {
      await this.redisClient.ping();
      return true;
    } catch {
      return false;
    }
  }
}

@Module({
  imports: [
    // Configure Bull with Redis
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisHost = config.get('REDIS_HOST', '127.0.0.1');
        const redisPort = config.get<number>('REDIS_PORT', 6380);

        console.log(`🔗 Connecting to Redis at ${redisHost}:${redisPort}`);

        return {
          connection: {
            host: redisHost,
            port: redisPort,
            maxRetriesPerRequest: null, // Critical for BullMQ
            enableReadyCheck: false,
            retryStrategy: (times: number) => {
              if (times > 10) {
                console.error('❌ Redis connection failed after 10 retries');
                return null;
              }
              const delay = Math.min(times * 100, 3000);
              console.log(
                `🔄 Redis retry attempt ${times}, waiting ${delay}ms`,
              );
              return delay;
            },
          },
          defaultJobOptions: {
            removeOnComplete: {
              age: 3600, // 1 hour
              count: 50,
            },
            removeOnFail: {
              age: 86400, // 24 hours
              count: 200,
            },
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
          },
        };
      },
    }),

    // Register the book-generation queue
    BullModule.registerQueue(
      {
        name: 'book-generation',
      },
      { name: 'document-generation' },
    ),

    TypeOrmModule.forFeature([Project, Job, Chapter, Translation, Document]),

    // Use forwardRef to break circular dependencies
    forwardRef(() => ContentModule),
    forwardRef(() => TranslationModule),
    forwardRef(() => DocumentModule),
    forwardRef(() => ImageModule),
  ],
  providers: [
    BookGenerationQueue,
    BookGenerationProcessor,
    RedisMonitorService,
    RedisCacheService,
    DocumentGenerationQueue,
  ],
  exports: [BookGenerationQueue, BullModule, DocumentGenerationQueue],
})
export class QueueModule implements OnModuleInit {
  private readonly logger = new Logger(QueueModule.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly redisMonitor: RedisMonitorService,
  ) {}

  async onModuleInit() {
    this.logger.log('📦 Queue Module Initialized');
    await this.redisMonitor.startMonitoring();
  }
}

// Export RedisMonitorService
export { RedisMonitorService, RedisCacheService };
