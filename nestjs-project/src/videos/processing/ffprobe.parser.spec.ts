import {
  type FfprobeOutput,
  InvalidMediaError,
  parseFfprobeOutput,
  thumbnailTimestamp,
} from './ffprobe.parser';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  avg_frame_rate: '30000/1001',
};
const audioStream = { codec_type: 'audio', codec_name: 'aac' };
const format = {
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration: '125.400000',
  bit_rate: '4500000',
};

describe('parseFfprobeOutput', () => {
  it('should map streams and format to duration and metadata', () => {
    const result = parseFfprobeOutput({
      streams: [videoStream, audioStream],
      format,
    });

    expect(result).toEqual({
      duration: 125.4,
      metadata: {
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        bitrate: 4500000,
        frame_rate: 29.97,
        container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      },
    });
  });

  it('should report a null audio codec when there is no audio stream', () => {
    const result = parseFfprobeOutput({ streams: [videoStream], format });

    expect(result.metadata.audio_codec).toBeNull();
  });

  it('should fall back to the stream duration and tolerate missing optional fields', () => {
    const result = parseFfprobeOutput({
      streams: [
        { codec_type: 'video', width: 640, height: 360, duration: '3.5' },
      ],
      format: {},
    });

    expect(result).toEqual({
      duration: 3.5,
      metadata: {
        width: 640,
        height: 360,
        video_codec: 'unknown',
        audio_codec: null,
        bitrate: null,
        frame_rate: null,
        container_format: 'unknown',
      },
    });
  });

  it.each([
    ['0/0', null],
    ['25/1', 25],
    ['24', 24],
  ])('should parse frame rate %s as %s', (rate, expected) => {
    const result = parseFfprobeOutput({
      streams: [{ ...videoStream, avg_frame_rate: rate }],
      format,
    });

    expect(result.metadata.frame_rate).toBe(expected);
  });

  it.each<[string, FfprobeOutput]>([
    ['no streams at all', { format }],
    ['only an audio stream', { streams: [audioStream], format }],
    [
      'only cover art',
      {
        streams: [
          { ...videoStream, disposition: { attached_pic: 1 } },
          audioStream,
        ],
        format,
      },
    ],
    [
      'a video stream without dimensions',
      { streams: [{ codec_type: 'video', codec_name: 'h264' }], format },
    ],
  ])('should reject %s as invalid media', (_label, output) => {
    expect(() => parseFfprobeOutput(output)).toThrow(InvalidMediaError);
  });

  it.each(['0.000000', 'N/A', undefined])(
    'should reject a duration of %s',
    (duration) => {
      expect(() =>
        parseFfprobeOutput({
          streams: [videoStream],
          format: { ...format, duration },
        }),
      ).toThrow('Could not determine the video duration');
    },
  );
});

describe('thumbnailTimestamp', () => {
  it.each([
    [2, 0.2],
    [60, 6],
    [100, 10],
    [7200, 10],
  ])('should pick %ds → %ds', (duration, expected) => {
    expect(thumbnailTimestamp(duration)).toBeCloseTo(expected);
  });
});
