import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bull';

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
import { ProjectModule } from './book/project.module';
// import { ProjectModule } from './modules/project/project.module';
// import { ContentModule } from './modules/content/content.module';
// import { TranslationModule } from './modules/translation/translation.module';
// import { DocumentModule } from './modules/document/document.module';
// import { ImageModule } from './modules/image/image.module';

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
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT ?? '6380', 10),
      },
    }),
    UserModule,
    ProjectModule,

    // ContentModule,
    // TranslationModule,
    // DocumentModule,
    // ImageModule,
  ],
})
export class AppModule {}
