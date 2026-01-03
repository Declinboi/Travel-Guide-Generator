import { IsEnum, IsArray, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Language } from 'src/DB/entities';

export class TranslateProjectDto {
  @ApiProperty({ enum: Language })
  @IsEnum(Language)
  targetLanguage: Language;

  @ApiProperty({ 
    description: 'Maintain the narrative style and personal tone',
    default: true,
    required: false
  })
  @IsOptional()
  maintainStyle?: boolean = true;
}

export class BulkTranslateDto {
  @ApiProperty({ 
    enum: Language, 
    isArray: true,
    description: 'Languages to translate to (excluding English)'
  })
  @IsArray()
  @IsEnum(Language, { each: true })
  targetLanguages: Language[];

  @ApiProperty({ 
    description: 'Maintain the narrative style and personal tone',
    default: true,
    required: false
  })
  @IsOptional()
  maintainStyle?: boolean = true;
}
