import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisCacheService } from '../queues.module';
// import { RedisCacheService } from './services/redis-cache.service';

@Global() // Make it available everywhere
@Module({
  imports: [ConfigModule],
  providers: [RedisCacheService],
  exports: [RedisCacheService],
})
export class CacheModule {}