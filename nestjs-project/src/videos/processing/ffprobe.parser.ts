import type { VideoMetadata } from '../entities/video.entity';
import {
  THUMBNAIL_MAX_OFFSET_SECONDS,
  THUMBNAIL_POSITION_RATIO,
} from './processing.constants';

/** The file is not a playable video; retrying cannot change that. */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = InvalidMediaError.name;
  }
}

/** Subset of `ffprobe -print_format json -show_format -show_streams`. */
export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
}

export interface MediaProbeResult {
  duration: number;
  metadata: VideoMetadata;
}

/** ffprobe reports frame rates as rationals such as `30000/1001`. */
function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator = '1'] = value.split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? Number(rate.toFixed(3)) : null;
}

function parsePositiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseFfprobeOutput(output: FfprobeOutput): MediaProbeResult {
  const streams = output.streams ?? [];
  // Cover art in audio files is exposed as a "video" stream; it is not one.
  const video = streams.find(
    (stream) =>
      stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  );
  if (!video || !video.width || !video.height) {
    throw new InvalidMediaError('No video stream found');
  }

  const duration = Number(output.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new InvalidMediaError('Could not determine the video duration');
  }

  const audio = streams.find((stream) => stream.codec_type === 'audio');

  return {
    duration,
    metadata: {
      width: video.width,
      height: video.height,
      video_codec: video.codec_name ?? 'unknown',
      audio_codec: audio?.codec_name ?? null,
      bitrate: parsePositiveInt(output.format?.bit_rate),
      frame_rate: parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate),
      container_format: output.format?.format_name ?? 'unknown',
    },
  };
}

/** Where to take the thumbnail frame: 10% into the video, at most 10s in. */
export function thumbnailTimestamp(durationSeconds: number): number {
  return Math.min(
    durationSeconds * THUMBNAIL_POSITION_RATIO,
    THUMBNAIL_MAX_OFFSET_SECONDS,
  );
}
