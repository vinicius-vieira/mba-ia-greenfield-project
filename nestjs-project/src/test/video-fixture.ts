import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SampleVideoOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  audio?: boolean;
}

export interface SampleVideo {
  path: string;
  /** Removes the temp directory holding the file. */
  cleanup: () => Promise<void>;
}

/**
 * Generates a small H.264 (+ AAC) MP4 from FFmpeg's synthetic sources, so no
 * binary fixture lives in the repository.
 */
export async function generateSampleVideo(
  options: SampleVideoOptions = {},
): Promise<SampleVideo> {
  const {
    durationSeconds = 2,
    width = 320,
    height = 240,
    audio = true,
  } = options;
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-fixture-'));
  const path = join(dir, 'sample.mp4');

  const inputs = [
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=10`,
  ];
  const codecs = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
  if (audio) {
    inputs.push(
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${durationSeconds}`,
    );
    codecs.push('-c:a', 'aac');
  }

  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-y',
    ...inputs,
    ...codecs,
    '-movflags',
    '+faststart',
    path,
  ]);

  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
