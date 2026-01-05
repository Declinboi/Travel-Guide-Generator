// src/modules/project/dto/create-book.dto.ts
import { IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateBookDto {
  @ApiProperty({ example: 'Asturias Travel Guide 2026' })
  @IsString()
  title: string;

  @ApiProperty({ 
    example: 'From Gijón to the Picos de Europa, Unlock Asturias\' 20 Most Breathtaking Adventures',
    required: false 
  })
  @IsString()
  @IsOptional()
  subtitle?: string;

  @ApiProperty({ example: 'John Smith' })
  @IsString()
  author: string;

  @ApiProperty({ 
    type: 'array',
    items: { type: 'string', format: 'binary' },
    description: 'Upload 10-12 chapter images (will be auto-distributed)',
    required: false
  })
  images?: any[];

  @ApiProperty({ 
    type: 'string',
    format: 'binary',
    description: 'Upload map for last page',
    required: false
  })
  mapImage?: any;

  @ApiProperty({ 
    example: ['Chapter 1 image', 'Chapter 2 image'],
    description: 'Captions for each image (optional)',
    required: false
  })
  @IsArray()
  @IsOptional()
  imageCaptions?: string[];

  @ApiProperty({ 
    example: 'Geographical Map of Asturias',
    required: false
  })
  @IsString()
  @IsOptional()
  mapCaption?: string;

  @ApiProperty({ 
    example: [1, 2, 2, 3, 3, 3, 4, 5, 5, 6],
    description: 'Chapter numbers for each image (if not provided, auto-distributed)',
    required: false
  })
  @IsArray()
  @IsOptional()
  imageChapterNumbers?: number[];
}