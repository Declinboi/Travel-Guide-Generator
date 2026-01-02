import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { Project } from './project.entity';
import { Language } from './translation.entity';

export enum DocumentType {
  PDF = 'PDF',
  DOCX = 'DOCX',
}

export enum DocumentStatus {
  PENDING = 'PENDING',
  GENERATING = 'GENERATING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('documents')
@Unique(['projectId', 'type', 'language'])
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: DocumentType,
  })
  type: DocumentType;

  @Column({
    type: 'enum',
    enum: Language,
  })
  language: Language;

  @Column()
  filename: string;

  @Column()
  url: string;

  @Column()
  storageKey: string;

  @Column({ nullable: true })
  size: number;

  @Column({
    type: 'enum',
    enum: DocumentStatus,
    default: DocumentStatus.PENDING,
  })
  status: DocumentStatus;

  @Column()
  projectId: string;

  @ManyToOne(() => Project, (project) => project.documents, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ nullable: true })
  completedAt: Date;
}