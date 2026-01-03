import { IsString, IsOptional, IsInt, IsBoolean, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UploadImageDto {
  @ApiProperty({ 
    type: 'string', 
    format: 'binary',
    description: 'Image file to upload'
  })
  file: any;

  @ApiProperty({ 
    example: 1,
    description: 'Chapter number where this image will appear',
    required: false
  })
  @IsInt()
  @Min(1)
  @IsOptional()
  chapterNumber?: number;

  @ApiProperty({ 
    example: 'Beautiful sunset over the mountains',
    required: false
  })
  @IsString()
  @IsOptional()
  caption?: string;

  @ApiProperty({ 
    example: 1,
    description: 'Position within the chapter (1 = top, 2 = middle, etc.)',
    required: false
  })
  @IsInt()
  @Min(1)
  @IsOptional()
  position?: number;

  @ApiProperty({ 
    example: false,
    description: 'Is this the final map that goes on the last page?',
    default: false
  })
  @IsBoolean()
  @IsOptional()
  isMap?: boolean = false;
}