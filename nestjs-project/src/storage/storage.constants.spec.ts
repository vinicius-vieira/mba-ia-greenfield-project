import { videoOriginalKey, videoThumbnailKey } from './storage.constants';

describe('storage key builders', () => {
  const videoId = '0b0e6c1e-6f0b-4c3a-9d55-1f6f1c8f6a11';

  it('should place the original file under the video prefix', () => {
    expect(videoOriginalKey(videoId)).toBe(`videos/${videoId}/original`);
  });

  it('should place the thumbnail next to the original', () => {
    expect(videoThumbnailKey(videoId)).toBe(`videos/${videoId}/thumbnail.jpg`);
  });
});
