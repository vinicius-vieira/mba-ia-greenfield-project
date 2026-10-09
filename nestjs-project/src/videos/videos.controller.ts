import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
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
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import {
  CompleteUploadDto,
  UploadCompletedDto,
} from './dto/complete-upload.dto';
import {
  CreatePartUrlsDto,
  PartUrlsDto,
  UploadedPartsDto,
} from './dto/create-part-urls.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { UploadInitiatedDto, UploadStateDto } from './dto/upload-state.dto';
import { VideoDetailsDto } from './dto/video-details.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

/** Error responses shared by every owner endpoint addressed by video id. */
function ApiOwnerErrors(): MethodDecorator {
  return applyDecorators(
    ApiResponse({
      status: 400,
      description: 'Validation failed (body or non-uuid id)',
      schema: errorSchema,
    }),
    ApiResponse({
      status: 401,
      description: 'Missing or invalid access token',
      schema: errorSchema,
    }),
    ApiResponse({
      status: 403,
      description: 'Video belongs to another channel',
      schema: errorSchema,
    }),
    ApiResponse({
      status: 404,
      description: 'Video not found',
      schema: errorSchema,
    }),
  );
}

/** Response pair of the public endpoints that redirect to the storage. */
function ApiStorageRedirect(target: string): MethodDecorator {
  return applyDecorators(
    ApiResponse({
      status: 302,
      description: `Redirect to a presigned storage URL for the ${target}, valid for one hour`,
    }),
    ApiVideoNotFound(),
  );
}

function ApiVideoNotFound(): MethodDecorator {
  return ApiResponse({
    status: 404,
    description: 'Unknown public id, or the video is not ready',
    schema: errorSchema,
  });
}

interface RedirectResponse {
  url: string;
  statusCode: number;
}

function redirectTo(url: string): RedirectResponse {
  return { url, statusCode: HttpStatus.FOUND };
}

function ApiUploadNotInProgress(): MethodDecorator {
  return ApiResponse({
    status: 409,
    description: 'Video status is not draft',
    schema: errorSchema,
  });
}

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

  @Get(':id/upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get upload and processing state',
    description:
      'Returns the state of a video to its owner: draft while uploading, processing after completion, then ready or failed.',
  })
  @ApiResponse({ status: 200, type: UploadStateDto })
  @ApiOwnerErrors()
  async getUploadState(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadStateDto> {
    return this.videosService.getUploadState(user.sub, id);
  }

  @Post(':id/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Issue presigned URLs for upload parts',
    description:
      'Returns one presigned PUT URL per requested part number. The client sends each part directly to the storage and keeps the ETag response header for completion.',
  })
  @ApiResponse({ status: 200, type: PartUrlsDto })
  @ApiOwnerErrors()
  @ApiUploadNotInProgress()
  async createPartUploadUrls(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePartUrlsDto,
  ): Promise<PartUrlsDto> {
    return this.videosService.createPartUploadUrls(
      user.sub,
      id,
      dto.part_numbers,
    );
  }

  @Get(':id/upload/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List parts already uploaded',
    description:
      'Lists the parts the storage has received so an interrupted upload can resume from the missing ones.',
  })
  @ApiResponse({ status: 200, type: UploadedPartsDto })
  @ApiOwnerErrors()
  @ApiUploadNotInProgress()
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadedPartsDto> {
    return this.videosService.listUploadedParts(user.sub, id);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort an upload',
    description:
      'Discards the multipart upload in the storage and deletes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted, draft deleted' })
  @ApiOwnerErrors()
  @ApiUploadNotInProgress()
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, id);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete an upload',
    description:
      'Assembles the uploaded parts into the final object, confirms its size, moves the video to processing and publishes the background processing job.',
  })
  @ApiResponse({ status: 200, type: UploadCompletedDto })
  @ApiOwnerErrors()
  @ApiUploadNotInProgress()
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<UploadCompletedDto> {
    return this.videosService.completeUpload(user.sub, id, dto.parts);
  }

  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get video details',
    description:
      'Public details of a processed video, addressed by its unique URL identifier.',
  })
  @ApiResponse({ status: 200, type: VideoDetailsDto })
  @ApiVideoNotFound()
  async getDetails(
    @Param('publicId') publicId: string,
  ): Promise<VideoDetailsDto> {
    return this.videosService.getPublicDetails(publicId);
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a presigned storage URL. The storage answers Range requests with 206 Partial Content, so playback starts without downloading the whole file.',
  })
  @ApiStorageRedirect('video file')
  async stream(@Param('publicId') publicId: string): Promise<RedirectResponse> {
    return redirectTo(await this.videosService.getStreamUrl(publicId));
  }

  @Public()
  @Get(':publicId/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a presigned storage URL that serves the original file as an attachment named after the uploaded file.',
  })
  @ApiStorageRedirect('video file (as attachment)')
  async download(
    @Param('publicId') publicId: string,
  ): Promise<RedirectResponse> {
    return redirectTo(await this.videosService.getDownloadUrl(publicId));
  }

  @Public()
  @Get(':publicId/thumbnail')
  @Redirect()
  @ApiOperation({
    summary: 'Get a video thumbnail',
    description:
      'Redirects to a presigned storage URL for the JPEG thumbnail generated during processing.',
  })
  @ApiStorageRedirect('thumbnail')
  async thumbnail(
    @Param('publicId') publicId: string,
  ): Promise<RedirectResponse> {
    return redirectTo(await this.videosService.getThumbnailUrl(publicId));
  }
}
