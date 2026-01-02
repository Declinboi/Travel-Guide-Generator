import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { User } from './user.entity';
import { Image } from './image.entity';
import { Chapter } from './chapter.entity';
import { Translation } from './translation.entity';
import { Document } from './document.entity';
import { Job } from './job.entity';

export enum ProjectStatus {
  DRAFT = 'DRAFT',
  GENERATING_CONTENT = 'GENERATING_CONTENT',
  TRANSLATING = 'TRANSLATING',
  GENERATING_DOCUMENTS = 'GENERATING_DOCUMENTS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  title: string;

  @Column({ nullable: true })
  subtitle: string;

  @Column()
  author: string;

  @Column({ nullable: true, type: 'text' })
  description: string;

  @Column({
    type: 'enum',
    enum: ProjectStatus,
    default: ProjectStatus.DRAFT,
  })
  status: ProjectStatus;

  @Column({ nullable: true, default: 10 })
  numberOfChapters: number;

  @Column({ nullable: true, default: 'MEDIUM' })
  contentLength: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ nullable: true })
  userId: string;

  @ManyToOne(() => User, (user) => user.projects, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @OneToMany(() => Image, (image) => image.project)
  images: Image[];

  @OneToMany(() => Chapter, (chapter) => chapter.project)
  chapters: Chapter[];

  @OneToMany(() => Translation, (translation) => translation.project)
  translations: Translation[];

  @OneToMany(() => Document, (document) => document.project)
  documents: Document[];

  @OneToMany(() => Job, (job) => job.project)
  jobs: Job[];
}