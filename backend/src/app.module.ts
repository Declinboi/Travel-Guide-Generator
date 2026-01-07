import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';

import {
  User,
  Project,
  Image,
  Chapter,
  Translation,
  Document,
  Job,
} from './DB/entities';
import { UserModule } from './auth/user.module';
import { ProjectModule } from './project/project.module';
import { ContentModule } from './content/content.module';
import { RedisQueueModule } from './DB/config/redis.config';
import { DocumentModule } from './documents/document.module';
import { TranslationModule } from './translation/translation.module';
import { ImageModule } from './images/image.module';
import { BookGeneratorModule } from './book gen/book-generator.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        url: configService.get('DATABASE_URL'),
        entities: [User, Project, Image, Chapter, Translation, Document, Job],
        synchronize: configService.get('NODE_ENV') === 'development',
        logging: false,
        ssl: false,
      }),
      inject: [ConfigService],
    }),
    EventEmitterModule.forRoot(),
    RedisQueueModule,
    AuthModule,
    UserModule,
    ProjectModule,
    ContentModule,
    TranslationModule,
    DocumentModule,
    ImageModule,
    BookGeneratorModule,
  ],
})
export class AppModule {}
