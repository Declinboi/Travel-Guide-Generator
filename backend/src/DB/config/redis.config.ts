import { BullModule } from '@nestjs/bull';
import { ConfigModule } from '@nestjs/config';

export const RedisQueueModule = BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: () => ({
    redis: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6380', 10),
      password: process.env.REDIS_PASSWORD || undefined,
    },
    defaultJobOptions: {
      removeOnComplete: true,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    },
  }),
});
