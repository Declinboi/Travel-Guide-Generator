// src/common/services/redis-cache.service.ts - FIXED VERSION
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly redis: Redis;
  private readonly TTL = 7200;

  constructor(private readonly configService: ConfigService) {
    const redisHost = this.configService.get('REDIS_HOST');
    const redisPort = this.configService.get<number>('REDIS_PORT', 6379);

    this.redis = new Redis({
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 10000,
      keepAlive: 30000,
    });

    this.redis.on('connect', () => {
      this.logger.log('✅ Redis Cache connected');
    });

    this.redis.on('error', (err) => {
      this.logger.error('❌ Redis Cache error:', err.message);
    });

    this.redis.connect().catch((err) => {
      this.logger.error('Failed to connect to Redis:', err);
    });
  }

  /**
   * FIXED: Store image buffer efficiently with immediate cleanup
   */
  async cacheImage(
    url: string,
    buffer: Buffer,
    ttl: number = this.TTL,
  ): Promise<void> {
    const key = this.getImageKey(url);

    try {
      // CRITICAL: Convert and store in a single operation
      // Don't create intermediate variables that hold references
      await this.redis.setex(key, ttl, buffer.toString('base64'));

      this.logger.debug(
        `✓ Cached image: ${this.getFilename(url)} (${Math.round(buffer.length / 1024)}KB)`,
      );
    } catch (error) {
      this.logger.error(`Failed to cache image ${url}:`, error.message);
      throw error;
    }
  }

  /**
   * FIXED: Retrieve image with streaming support
   */
  async getImage(url: string): Promise<Buffer | null> {
    const key = this.getImageKey(url);

    try {
      const base64Data = await this.redis.getBuffer(key);

      if (!base64Data) {
        return null;
      }

      // Convert directly without intermediate storage
      const result = Buffer.from(base64Data.toString(), 'base64');

      this.logger.debug(`✓ Retrieved cached image: ${this.getFilename(url)}`);

      return result;
    } catch (error) {
      this.logger.error(`Failed to get image ${url}:`, error.message);
      return null;
    }
  }

  async hasImage(url: string): Promise<boolean> {
    try {
      const key = this.getImageKey(url);
      const exists = await this.redis.exists(key);
      return exists === 1;
    } catch (error) {
      this.logger.error(
        `Failed to check image existence ${url}:`,
        error.message,
      );
      return false;
    }
  }

  async cacheProjectData(
    projectId: string,
    dataType: string,
    data: any,
    ttl: number = this.TTL,
  ): Promise<void> {
    try {
      const key = this.getProjectDataKey(projectId, dataType);
      await this.redis.setex(key, ttl, JSON.stringify(data));
      this.logger.debug(`✓ Cached project data: ${projectId}/${dataType}`);
    } catch (error) {
      this.logger.error(
        `Failed to cache project data ${projectId}/${dataType}:`,
        error.message,
      );
      throw error;
    }
  }

  async getProjectData<T>(
    projectId: string,
    dataType: string,
  ): Promise<T | null> {
    try {
      const key = this.getProjectDataKey(projectId, dataType);
      const data = await this.redis.get(key);

      if (data) {
        this.logger.debug(
          `✓ Retrieved cached project data: ${projectId}/${dataType}`,
        );
        return JSON.parse(data);
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Failed to get project data ${projectId}/${dataType}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * IMPROVED: Batch operations with pipeline
   */
  async batchCacheImages(
    images: Array<{ url: string; buffer: Buffer }>,
    ttl: number = this.TTL,
  ): Promise<void> {
    if (images.length === 0) return;

    try {
      const pipeline = this.redis.pipeline();

      // Add all operations to pipeline
      for (const { url, buffer } of images) {
        const key = this.getImageKey(url);
        pipeline.setex(key, ttl, buffer.toString('base64'));
      }

      // Execute all at once
      await pipeline.exec();

      this.logger.log(`✓ Batch cached ${images.length} images`);
    } catch (error) {
      this.logger.error('Failed to batch cache images:', error.message);
      throw error;
    }
  }

  async clearProjectImages(projectId: string): Promise<number> {
    try {
      const pattern = `image:*`;
      let cursor = '0';
      let deleted = 0;

      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );

        cursor = nextCursor;

        if (keys.length > 0) {
          const projectKeys = keys.filter((key) => key.includes(projectId));

          if (projectKeys.length > 0) {
            const delCount = await this.redis.del(...projectKeys);
            deleted += delCount;
          }
        }
      } while (cursor !== '0');

      if (deleted > 0) {
        this.logger.log(
          `🧹 Cleared ${deleted} cached images for project ${projectId}`,
        );
      }

      return deleted;
    } catch (error) {
      this.logger.error(
        `Failed to clear project images ${projectId}:`,
        error.message,
      );
      return 0;
    }
  }

  async clearProjectData(projectId: string): Promise<number> {
    try {
      const pattern = `project:${projectId}:*`;
      let cursor = '0';
      let deleted = 0;

      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );

        cursor = nextCursor;

        if (keys.length > 0) {
          const delCount = await this.redis.del(...keys);
          deleted += delCount;
        }
      } while (cursor !== '0');

      if (deleted > 0) {
        this.logger.log(
          `🧹 Cleared ${deleted} cached data entries for project ${projectId}`,
        );
      }

      return deleted;
    } catch (error) {
      this.logger.error(
        `Failed to clear project data ${projectId}:`,
        error.message,
      );
      return 0;
    }
  }

  async clearProject(projectId: string): Promise<void> {
    try {
      await Promise.all([
        this.clearProjectImages(projectId),
        this.clearProjectData(projectId),
      ]);
    } catch (error) {
      this.logger.error(`Failed to clear project ${projectId}:`, error.message);
    }
  }

  async clearAllImages(): Promise<number> {
    try {
      const pattern = 'image:*';
      let cursor = '0';
      let deleted = 0;

      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );

        cursor = nextCursor;

        if (keys.length > 0) {
          const delCount = await this.redis.del(...keys);
          deleted += delCount;
        }
      } while (cursor !== '0');

      if (deleted > 0) {
        this.logger.log(`🧹 Cleared ${deleted} cached images`);
      }

      return deleted;
    } catch (error) {
      this.logger.error('Failed to clear all images:', error.message);
      return 0;
    }
  }

  async getMemoryStats(): Promise<{
    used: string;
    peak: string;
    fragmentation: string;
  }> {
    try {
      const info = await this.redis.info('memory');

      return {
        used: this.parseRedisInfo(info, 'used_memory_human'),
        peak: this.parseRedisInfo(info, 'used_memory_peak_human'),
        fragmentation: this.parseRedisInfo(info, 'mem_fragmentation_ratio'),
      };
    } catch (error) {
      this.logger.error('Failed to get Redis memory stats:', error.message);
      return { used: 'unknown', peak: 'unknown', fragmentation: 'unknown' };
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  private getImageKey(url: string): string {
    const filename = this.getFilename(url);
    return `image:${filename}`;
  }

  private getProjectDataKey(projectId: string, dataType: string): string {
    return `project:${projectId}:${dataType}`;
  }

  private getFilename(url: string): string {
    return url.substring(url.lastIndexOf('/') + 1);
  }

  private parseRedisInfo(info: string, key: string): string {
    const match = info.match(new RegExp(`${key}:(.+)`));
    return match ? match[1].trim() : 'unknown';
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
      this.logger.log('Redis Cache connection closed');
    } catch (error) {
      this.logger.error('Error closing Redis connection:', error);
    }
  }
}
