import { generateVideoPublicId } from './video-public-id.util';

describe('generateVideoPublicId', () => {
  it('should produce 11 URL-safe characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateVideoPublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should not repeat across a large sample', () => {
    const sample = new Set<string>();
    for (let i = 0; i < 10_000; i++) sample.add(generateVideoPublicId());

    expect(sample.size).toBe(10_000);
  });

  it('should use every symbol of the alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      for (const char of generateVideoPublicId()) seen.add(char);
    }

    expect(seen.size).toBe(64);
  });
});
