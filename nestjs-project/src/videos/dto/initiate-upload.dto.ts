import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_CONTENT_TYPE_PATTERN,
} from '../videos.constants';

export class InitiateUploadDto {
  /** Original file name, e.g. `holiday.mp4`. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** MIME type of the file; must be a video type, e.g. `video/mp4`. */
  @IsString()
  @MaxLength(100)
  @Matches(VIDEO_CONTENT_TYPE_PATTERN, {
    message: 'content_type must be a video MIME type',
  })
  content_type: string;

  /** File size in bytes (up to 10GB). */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size: number;

  /** Video title; defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;
}
