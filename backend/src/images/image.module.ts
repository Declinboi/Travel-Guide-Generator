import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImageService } from './image.service';
import { ImageController } from './image.controller';
import { CloudinaryService } from './cloudinary.service';
import { Chapter } from 'src/DB/entities/chapter.entity';
import { Image, Project } from 'src/DB/entities';

@Module({
  imports: [TypeOrmModule.forFeature([Image, Project, Chapter])],
  controllers: [ImageController],
  providers: [ImageService, CloudinaryService],
  exports: [ImageService, CloudinaryService],
})
export class ImageModule {}