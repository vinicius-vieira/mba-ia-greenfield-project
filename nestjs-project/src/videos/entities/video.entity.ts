import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export interface VideoMetadata {
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  bitrate: number | null;
  frame_rate: number | null;
  container_format: string;
}

// PostgreSQL returns bigint as a string; video sizes (≤ 10GB) fit a JS number.
const bigintToNumber = {
  to: (value: number): number => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity('videos')
export class Video {
  // Assigned by the application before insert: the storage key embeds it.
  @PrimaryColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  size: number;

  @Column({ type: 'varchar', length: 255 })
  storage_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'double precision', nullable: true })
  duration: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'text', nullable: true })
  failure_reason: string | null;

  @Column({ type: 'timestamp', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
