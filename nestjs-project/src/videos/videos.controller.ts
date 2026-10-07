import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { UploadInitiatedDto } from './dto/upload-state.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

// The auth rate limit (10 req/min) does not apply here: an upload legitimately
// calls these endpoints many times.
@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Pre-registers the video as a draft owned by the caller's channel and opens a multipart upload in the object storage. The file bytes are then sent directly to the storage through presigned part URLs.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload opened',
    type: UploadInitiatedDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Authenticated user has no channel',
    schema: errorSchema,
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<UploadInitiatedDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }
}
