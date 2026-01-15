// src/common/services/redis-cache.service.ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly redis: Redis;
  private readonly TTL = 3600; // 1 hour default TTL

  constructor(private readonly configService: ConfigService) {
    const redisHost = this.configService.get('REDIS_HOST', '127.0.0.1');
    const redisPort = this.configService.get<number>('REDIS_PORT', 6380);

    this.redis = new Redis({
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });

    this.redis.on('connect', () => {
      this.logger.log('✅ Redis Cache connected');
    });

    this.redis.on('error', (err) => {
      this.logger.error('❌ Redis Cache error:', err.message);
    });

    this.redis.connect().catch(err => {
      this.logger.error('Failed to connect to Redis:', err);
    });
  }

  /**
   * Store image buffer in Redis with automatic expiration
   */
  async cacheImage(url: string, buffer: Buffer, ttl: number = this.TTL): Promise<void> {
    try {
      const key = this.getImageKey(url);
      await this.redis.setex(key, ttl, buffer);
      this.logger.debug(`✓ Cached image: ${this.getFilename(url)} (${Math.round(buffer.length / 1024)}KB)`);
    } catch (error) {
      this.logger.error(`Failed to cache image ${url}:`, error);
      throw error;
    }
  }

  /**
   * Retrieve image buffer from Redis
   */
  async getImage(url: string): Promise<Buffer | null> {
    try {
      const key = this.getImageKey(url);
      const data = await this.redis.getBuffer(key);
      
      if (data) {
        this.logger.debug(`✓ Retrieved cached image: ${this.getFilename(url)}`);
        return data;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Failed to get image ${url}:`, error);
      return null;
    }
  }

  /**
   * Check if image exists in cache
   */
  async hasImage(url: string): Promise<boolean> {
    try {
      const key = this.getImageKey(url);
      const exists = await this.redis.exists(key);
      return exists === 1;
    } catch (error) {
      this.logger.error(`Failed to check image existence ${url}:`, error);
      return false;
    }
  }

  /**
   * Store project data (chapters, translations, etc.) in Redis
   */
  async cacheProjectData(projectId: string, dataType: string, data: any, ttl: number = this.TTL): Promise<void> {
    try {
      const key = this.getProjectDataKey(projectId, dataType);
      await this.redis.setex(key, ttl, JSON.stringify(data));
      this.logger.debug(`✓ Cached project data: ${projectId}/${dataType}`);
    } catch (error) {
      this.logger.error(`Failed to cache project data ${projectId}/${dataType}:`, error);
      throw error;
    }
  }

  /**
   * Retrieve project data from Redis
   */
  async getProjectData<T>(projectId: string, dataType: string): Promise<T | null> {
    try {
      const key = this.getProjectDataKey(projectId, dataType);
      const data = await this.redis.get(key);
      
      if (data) {
        this.logger.debug(`✓ Retrieved cached project data: ${projectId}/${dataType}`);
        return JSON.parse(data);
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Failed to get project data ${projectId}/${dataType}:`, error);
      return null;
    }
  }

  /**
   * Clear all cached images for a project
   */
  async clearProjectImages(projectId: string): Promise<number> {
    try {
      const pattern = this.getImageKey(`*${projectId}*`);
      const keys = await this.redis.keys(pattern);
      
      if (keys.length > 0) {
        const deleted = await this.redis.del(...keys);
        this.logger.log(`🧹 Cleared ${deleted} cached images for project ${projectId}`);
        return deleted;
      }
      
      return 0;
    } catch (error) {
      this.logger.error(`Failed to clear project images ${projectId}:`, error);
      return 0;
    }
  }

  /**
   * Clear all project data
   */
  async clearProjectData(projectId: string): Promise<number> {
    try {
      const pattern = this.getProjectDataKey(projectId, '*');
      const keys = await this.redis.keys(pattern);
      
      if (keys.length > 0) {
        const deleted = await this.redis.del(...keys);
        this.logger.log(`🧹 Cleared ${deleted} cached data entries for project ${projectId}`);
        return deleted;
      }
      
      return 0;
    } catch (error) {
      this.logger.error(`Failed to clear project data ${projectId}:`, error);
      return 0;
    }
  }

  /**
   * Clear everything related to a project
   */
  async clearProject(projectId: string): Promise<void> {
    await Promise.all([
      this.clearProjectImages(projectId),
      this.clearProjectData(projectId),
    ]);
  }

  /**
   * Get Redis memory usage stats
   */
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
      this.logger.error('Failed to get Redis memory stats:', error);
      return { used: 'unknown', peak: 'unknown', fragmentation: 'unknown' };
    }
  }

  /**
   * Batch cache multiple images
   */
  async batchCacheImages(images: Array<{ url: string; buffer: Buffer }>, ttl: number = this.TTL): Promise<void> {
    const pipeline = this.redis.pipeline();
    
    for (const { url, buffer } of images) {
      const key = this.getImageKey(url);
      pipeline.setex(key, ttl, buffer);
    }
    
    await pipeline.exec();
    this.logger.log(`✓ Batch cached ${images.length} images`);
  }

  // Private helper methods
  private getImageKey(url: string): string {
    return `image:${url}`;
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
    await this.redis.quit();
    this.logger.log('Redis Cache connection closed');
  }
}