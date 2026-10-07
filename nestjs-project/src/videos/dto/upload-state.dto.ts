import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadPlanDto {
  @ApiProperty({ example: 16777216, description: 'Size of each part in bytes' })
  part_size: number;

  @ApiProperty({ example: 640, description: 'Number of parts to upload' })
  part_count: number;
}

export class UploadInitiatedDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty({ example: 'holiday' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;
}

export class UploadStateDto extends UploadInitiatedDto {
  @ApiProperty({ type: String, nullable: true, example: null })
  failure_reason: string | null;

  @ApiProperty({ example: 1048576, description: 'Declared size in bytes' })
  size: number;

  @ApiProperty({ format: 'date-time' })
  created_at: Date;
}
