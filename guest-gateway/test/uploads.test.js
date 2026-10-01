// guest-gateway/test/uploads.test.js

import { extensionOf, sanitizeFilename } from '../src/uploads.js';

describe('sanitizeFilename', () => {
  it('drops directory parts and control characters', () => {
    expect(sanitizeFilename('../../etc/passwd.jpg')).toBe('passwd.jpg');
    expect(sanitizeFilename('C:\\Users\\a\\IMG_0001.HEIC')).toBe('IMG_0001.HEIC');
    expect(sanitizeFilename('a\u0000b\nc.jpg')).toBe('abc.jpg');
    expect(sanitizeFilename(undefined)).toBe('');
  });

  it('keeps the extension when truncating long names', () => {
    const long = `${'a'.repeat(500)}.mov`;
    expect(sanitizeFilename(long)).toHaveLength(200);
    expect(sanitizeFilename(long).endsWith('.mov')).toBe(true);
  });
});

describe('extensionOf', () => {
  it('returns the lower-cased extension or empty', () => {
    expect(extensionOf('IMG_0001.HEIC')).toBe('heic');
    expect(extensionOf('movie.final.MP4')).toBe('mp4');
    expect(extensionOf('.jpg')).toBe('');
    expect(extensionOf('noext')).toBe('');
  });
});
