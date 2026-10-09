import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { VideoStatus } from '../entities/video.entity';
import { MAX_UPLOAD_PARTS } from '../videos.constants';

export class CompletedPartDto {
  /** Part number (1-based) the bytes were uploaded as. */
  @IsInt()
  @Min(1)
  part_number: number;

  /** `ETag` response header the storage returned for that part. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every uploaded part with its ETag. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_UPLOAD_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}

export class UploadCompletedDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;
}
