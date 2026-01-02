import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Project } from './project.entity';

export enum JobType {
  CONTENT_GENERATION = 'CONTENT_GENERATION',
  TRANSLATION = 'TRANSLATION',
  PDF_GENERATION = 'PDF_GENERATION',
  DOCX_GENERATION = 'DOCX_GENERATION',
  IMAGE_PROCESSING = 'IMAGE_PROCESSING',
}

export enum JobStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: JobType,
  })
  type: JobType;

  @Column({
    type: 'enum',
    enum: JobStatus,
    default: JobStatus.PENDING,
  })
  status: JobStatus;

  @Column({ type: 'json', nullable: true })
  data: any;

  @Column({ type: 'json', nullable: true })
  result: any;

  @Column({ nullable: true, type: 'text' })
  error: string;

  @Column({ default: 0 })
  progress: number;

  @Column()
  projectId: string;

  @ManyToOne(() => Project, (project) => project.jobs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ nullable: true })
  startedAt: Date;

  @Column({ nullable: true })
  completedAt: Date;
}