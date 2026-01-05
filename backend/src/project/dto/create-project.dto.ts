import { IsString, IsOptional, IsInt, Min, Max, IsEnum, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProjectDto {
  @ApiProperty({ example: 'Ultimate Guide to Paris' })
  @IsString()
  title: string;

  @ApiProperty({ example: 'Discover the City of Light', required: false })
  @IsString()
  @IsOptional()
  subtitle?: string;

  @ApiProperty({ example: 'John Smith' })
  @IsString()
  author: string;

  @ApiProperty({ 
    example: 'A comprehensive travel guide covering all major attractions, hidden gems, and local cuisine in Paris.',
    required: false 
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 10, default: 10, minimum: 5, maximum: 30 })
  @IsInt()
  @Min(5)
  @Max(30)
  @IsOptional()
  numberOfChapters?: number = 10;

  @ApiProperty({ 
    example: 'MEDIUM',
    enum: ['SHORT', 'MEDIUM', 'LONG'],
    default: 'MEDIUM'
  })
  @IsEnum(['SHORT', 'MEDIUM', 'LONG'])
  @IsOptional()
  contentLength?: string = 'MEDIUM';

  @ApiProperty({ example: 'uuid-here', required: false })
  @IsUUID()
  @IsOptional()
  userId?: string;
}
