import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StorageService } from '../../storage/storage.service';
import { createTestStorageService } from '../../test/storage-test-env';
import { generateSampleVideo, SampleVideo } from '../../test/video-fixture';
import { InvalidMediaError } from './ffprobe.parser';
import { MediaInspectorService } from './media-inspector.service';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('MediaInspectorService (integration)', () => {
  const inspector = new MediaInspectorService();
  let sample: SampleVideo;

  beforeAll(async () => {
    sample = await generateSampleVideo();
  }, 30_000);

  afterAll(async () => {
    await sample.cleanup();
  });

  describe('probe', () => {
    it('should read duration, dimensions and codecs of an MP4', async () => {
      const result = await inspector.probe(sample.path);

      expect(result.duration).toBeCloseTo(2, 0);
      expect(result.metadata).toMatchObject({
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
        frame_rate: 10,
      });
      expect(result.metadata.container_format).toContain('mp4');
      expect(result.metadata.bitrate).toBeGreaterThan(0);
    });

    it('should report a null audio codec for a video-only file', async () => {
      const silent = await generateSampleVideo({ audio: false });

      const result = await inspector.probe(silent.path);

      expect(result.metadata.audio_codec).toBeNull();
      expect(result.metadata.video_codec).toBe('h264');
      await silent.cleanup();
    }, 30_000);

    it('should reject a file that is not media', async () => {
      const textFile = join(dirname(sample.path), 'notes.mp4');
      await writeFile(textFile, 'this is definitely not a video\n'.repeat(50));

      await expect(inspector.probe(textFile)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should report an unreadable input as a plain (retryable) error', async () => {
      const failure = inspector.probe(
        join(dirname(sample.path), 'missing.mp4'),
      );

      await expect(failure).rejects.toThrow(/^ffprobe failed: /);
      await expect(failure).rejects.not.toBeInstanceOf(InvalidMediaError);
    });
  });

  describe('captureThumbnail', () => {
    it('should write a JPEG frame keeping the source size when it is small', async () => {
      const output = join(dirname(sample.path), 'small.jpg');

      await inspector.captureThumbnail(sample.path, 2, output);

      const image = await readFile(output);
      expect(image.subarray(0, 3)).toEqual(JPEG_MAGIC);
      expect(await jpegSize(output)).toEqual({ width: 320, height: 240 });
    });

    it('should shrink a wide source to at most 1280px', async () => {
      const wide = await generateSampleVideo({
        width: 1920,
        height: 1080,
        durationSeconds: 1,
        audio: false,
      });
      const output = join(dirname(wide.path), 'wide.jpg');

      await inspector.captureThumbnail(wide.path, 1, output);

      expect(await jpegSize(output)).toEqual({ width: 1280, height: 720 });
      await wide.cleanup();
    }, 60_000);

    it('should fail for a source that is not media', async () => {
      const textFile = join(dirname(sample.path), 'fake.mp4');
      await writeFile(textFile, 'not a video');

      await expect(
        inspector.captureThumbnail(
          textFile,
          2,
          join(dirname(textFile), 'x.jpg'),
        ),
      ).rejects.toBeInstanceOf(InvalidMediaError);
    });
  });

  describe('URL input (storage)', () => {
    let storage: StorageService;
    const key = `test/${randomUUID()}/original`;

    beforeAll(async () => {
      storage = await createTestStorageService();
      await storage.putObject(key, await readFile(sample.path), 'video/mp4');
    });

    afterAll(async () => {
      await storage.deleteObject(key);
    });

    it('should probe and capture through a presigned URL without downloading the file', async () => {
      const url = await storage.presignGetObject(key, {
        expiresIn: 60,
        audience: 'internal',
      });
      const output = join(dirname(sample.path), 'remote.jpg');

      const remote = await inspector.probe(url);
      await inspector.captureThumbnail(url, remote.duration, output);

      expect(remote).toEqual(await inspector.probe(sample.path));
      expect(await jpegSize(output)).toEqual({ width: 320, height: 240 });
    });
  });
});

/** Reads the frame size from the JPEG's SOF marker. */
async function jpegSize(
  path: string,
): Promise<{ width: number; height: number }> {
  const data = await readFile(path);
  let offset = 2;
  while (offset < data.length) {
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    // SOF0..SOF3 carry the frame dimensions.
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error('No SOF marker found in JPEG');
}
