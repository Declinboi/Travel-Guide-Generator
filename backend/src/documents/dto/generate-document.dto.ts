import { IsEnum, IsUUID, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Language } from 'src/DB/entities/translation.entity';
import { DocumentType } from 'src/DB/entities';

export class GenerateDocumentDto {
  @ApiProperty({ enum: DocumentType })
  @IsEnum(DocumentType)
  type: DocumentType;

  @ApiProperty({ enum: Language })
  @IsEnum(Language)
  language: Language;

  @ApiProperty({ required: false })
  @IsOptional()
  includeImages?: boolean = true;
}

export class BulkGenerateDocumentsDto {
  @ApiProperty({ enum: DocumentType, isArray: true })
  @IsArray()
  @IsEnum(DocumentType, { each: true })
  types: DocumentType[];

  @ApiProperty({ enum: Language, isArray: true })
  @IsArray()
  @IsEnum(Language, { each: true })
  languages: Language[];

  @ApiProperty({ required: false })
  @IsOptional()
  includeImages?: boolean = true;
}