import { IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateBookDto {
  @ApiProperty({ example: 'Asturias Travel Guide 2026' })
  @IsString()
  title: string;

  @ApiProperty({
    example:
      "From Gijón to the Picos de Europa, Unlock Asturias' 20 Most Breathtaking Adventures",
    required: false,
  })
  @IsString()
  @IsOptional()
  subtitle?: string;

  @ApiProperty({ example: 'John Smith' })
  @IsString()
  author: string;

  // Remove images and mapImage from DTO - they're handled by @UseInterceptors
  // Keep only the metadata fields that come from the form

  @ApiProperty({
    example: ['Chapter 1 image', 'Chapter 2 image'],
    description: 'Captions for each image (optional)',
    required: false,
    type: [String],
  })
  @IsArray()
  @IsOptional()
  imageCaptions?: string[];

  @ApiProperty({
    example: 'Geographical Map of Asturias',
    required: false,
  })
  @IsString()
  @IsOptional()
  mapCaption?: string;

  @ApiProperty({
    example: [1, 2, 2, 3, 3, 3, 4, 5, 5, 6],
    description:
      'Chapter numbers for each image (if not provided, auto-distributed)',
    required: false,
    type: [Number],
  })
  @IsArray()
  @IsOptional()
  imageChapterNumbers?: number[];
}
