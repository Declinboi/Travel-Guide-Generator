import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { Project } from './project.entity';

export enum Language {
  ENGLISH = 'ENGLISH',
  GERMAN = 'GERMAN',
  FRENCH = 'FRENCH',
  SPANISH = 'SPANISH',
  ITALIAN = 'ITALIAN',
}

export enum TranslationStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('translations')
@Unique(['projectId', 'language'])
export class Translation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: Language,
  })
  language: Language;

  @Column()
  title: string;

  @Column({ nullable: true })
  subtitle: string;

  @Column('json')
  content: any;

  @Column({
    type: 'enum',
    enum: TranslationStatus,
    default: TranslationStatus.PENDING,
  })
  status: TranslationStatus;

  @Column()
  projectId: string;

  @ManyToOne(() => Project, (project) => project.translations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ nullable: true })
  completedAt: Date;
}