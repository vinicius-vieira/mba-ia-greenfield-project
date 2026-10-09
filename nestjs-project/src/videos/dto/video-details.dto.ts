import { ApiProperty } from '@nestjs/swagger';

export class VideoMetadataDto {
  @ApiProperty({ example: 1920 })
  width: number;

  @ApiProperty({ example: 1080 })
  height: number;

  @ApiProperty({ example: 'h264' })
  video_codec: string;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 4500000,
    description: 'Overall bitrate in bits per second',
  })
  bitrate: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 29.97 })
  frame_rate: number | null;

  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  container_format: string;
}

export class VideoChannelDto {
  @ApiProperty({ example: 'john_doe' })
  nickname: string;

  @ApiProperty({ example: 'john_doe' })
  name: string;
}

export class VideoDetailsDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty({ example: 'holiday' })
  title: string;

  @ApiProperty({ example: 125.4, description: 'Duration in seconds' })
  duration: number;

  @ApiProperty({ type: VideoMetadataDto })
  metadata: VideoMetadataDto;

  @ApiProperty({ example: 1048576, description: 'File size in bytes' })
  size: number;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  @ApiProperty({ format: 'date-time' })
  created_at: Date;
}
