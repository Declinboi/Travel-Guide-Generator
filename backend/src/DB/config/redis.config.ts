// import { BullModule } from '@nestjs/bull';
// import { ConfigModule } from '@nestjs/config';

// export const RedisQueueModule = BullModule.forRootAsync({
//   imports: [ConfigModule],
//   useFactory: () => ({
//     redis: {
//       host: process.env.REDIS_HOST || '127.0.0.1',
//       port: parseInt(process.env.REDIS_PORT || '6380', 10),
//       password: process.env.REDIS_PASSWORD || undefined,
//     },
//     defaultJobOptions: {
//       removeOnComplete: true,
//       attempts: 3,
//       backoff: {
//         type: 'exponential',
//         delay: 2000,
//       },
//     },
//   }),
// });


import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const RedisQueueModule = BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connection: {
      host: config.get('REDIS_HOST', '127.0.0.1'),
      port: config.get<number>('REDIS_PORT', 6380),
      password: config.get('REDIS_PASSWORD'),
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
