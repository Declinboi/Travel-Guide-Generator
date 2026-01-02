import { IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GenerateTravelGuideDto {
  @ApiProperty({ example: 'Asturias Travel Guide 2026' })
  @IsString()
  title: string;

  @ApiProperty({ 
    example: 'From Gijón to the Picos de Europa, Unlock Asturias\' 20 Most Breathtaking Adventures and Local Secrets',
    required: false 
  })
  @IsString()
  @IsOptional()
  subtitle?: string;

  @ApiProperty({ example: 'John Smith' })
  @IsString()
  author: string;

  @ApiProperty({ 
    example: 'A comprehensive travel guide covering adventures, local culture, and hidden gems',
    required: false 
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 10, default: 10 })
  numberOfChapters?: number;
}

export class BookOutlineDto {
  @ApiProperty()
  title: string;

  @ApiProperty()
  subtitle?: string;

  @ApiProperty()
  author: string;

  @ApiProperty({ type: [Object] })
  chapters: ChapterOutline[];
}

export class ChapterOutline {
  chapterNumber: number;
  chapterTitle: string;
  sections: SectionOutline[];
}

export class SectionOutline {
  sectionTitle: string;
  subsections: string[];
}