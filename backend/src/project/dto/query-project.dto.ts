import { IsOptional, IsEnum, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProjectStatus } from '../../DB/entities/project.entity';

export class QueryProjectDto {
  @ApiProperty({ 
    enum: ProjectStatus,
    required: false,
    description: 'Filter by project status'
  })
  @IsEnum(ProjectStatus)
  @IsOptional()
  status?: ProjectStatus;

  @ApiProperty({ required: false, description: 'Filter by user ID' })
  @IsUUID()
  @IsOptional()
  userId?: string;
}