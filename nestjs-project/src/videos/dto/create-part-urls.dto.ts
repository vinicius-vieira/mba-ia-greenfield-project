import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { MAX_PART_URLS_PER_REQUEST } from '../videos.constants';

export class CreatePartUrlsDto {
  /** Part numbers (1-based) to issue upload URLs for; at most 100 per call. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PART_URLS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description:
      'Presigned storage URL: send the part bytes with HTTP PUT and keep the ETag response header',
  })
  url: string;
}

export class PartUrlsDto {
  @ApiProperty({ type: [PartUrlDto] })
  urls: PartUrlDto[];

  @ApiProperty({ example: 3600, description: 'URL lifetime in seconds' })
  expires_in: number;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;

  @ApiProperty({ example: 16777216 })
  size: number;
}

export class UploadedPartsDto {
  @ApiProperty({ type: [UploadedPartDto] })
  parts: UploadedPartDto[];
}
