import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import {
  type FfprobeOutput,
  InvalidMediaError,
  type MediaProbeResult,
  parseFfprobeOutput,
  thumbnailTimestamp,
} from './ffprobe.parser';
import {
  FFMPEG_BINARY,
  FFMPEG_TIMEOUT_MS,
  FFPROBE_BINARY,
  FFPROBE_MAX_OUTPUT_BYTES,
  FFPROBE_TIMEOUT_MS,
  INVALID_MEDIA_STDERR_PATTERNS,
  THUMBNAIL_MAX_WIDTH,
} from './processing.constants';

const execFileAsync = promisify(execFile);

function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr.trim() : '';
}

/**
 * Wraps the FFmpeg binaries. Inputs are file paths or URLs: given a presigned
 * storage URL, FFmpeg fetches only the byte ranges it needs, so a 10GB source
 * is never downloaded in full.
 */
@Injectable()
export class MediaInspectorService {
  async probe(input: string): Promise<MediaProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        FFPROBE_BINARY,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          input,
        ],
        { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: FFPROBE_MAX_OUTPUT_BYTES },
      ));
    } catch (err) {
      throw this.classify(err, 'ffprobe');
    }

    return parseFfprobeOutput(JSON.parse(stdout) as FfprobeOutput);
  }

  /** Writes one JPEG frame of `input` to `outputPath`. */
  async captureThumbnail(
    input: string,
    durationSeconds: number,
    outputPath: string,
  ): Promise<void> {
    try {
      await execFileAsync(
        FFMPEG_BINARY,
        [
          '-v',
          'error',
          '-y',
          // Before `-i`: seek in the input instead of decoding up to the frame.
          '-ss',
          thumbnailTimestamp(durationSeconds).toFixed(3),
          '-i',
          input,
          '-frames:v',
          '1',
          // Shrink to the max width keeping the aspect ratio; never upscale.
          '-vf',
          `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
          '-q:v',
          '3',
          outputPath,
        ],
        { timeout: FFMPEG_TIMEOUT_MS },
      );
    } catch (err) {
      throw this.classify(err, 'ffmpeg');
    }
  }

  private classify(err: unknown, tool: string): Error {
    const stderr = stderrOf(err);
    if (INVALID_MEDIA_STDERR_PATTERNS.some((pattern) => pattern.test(stderr))) {
      return new InvalidMediaError('File is not a valid video');
    }
    const detail = stderr || (err instanceof Error ? err.message : String(err));
    return new Error(`${tool} failed: ${detail}`);
  }
}
