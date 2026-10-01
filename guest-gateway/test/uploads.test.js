// guest-gateway/test/uploads.test.js

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  correctExtension,
  EXTENSIONS_BY_MIME,
  extensionOf,
  sanitizeFilename,
  scanStaging,
} from '../src/uploads.js';
import { TMP_ROOT } from './helpers/server.js';

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

describe('correctExtension', () => {
  it('leaves names whose extension belongs to the content (any case, either family member)', () => {
    expect(correctExtension('IMG_0001.JPG', 'image/jpeg')).toBeNull();
    expect(correctExtension('IMG_0001.jpeg', 'image/jpeg')).toBeNull();
    expect(correctExtension('IMG_0001.HEIF', 'image/heic')).toBeNull();
    expect(correctExtension('IMG_0001.heic', 'image/heif')).toBeNull();
    expect(correctExtension('clip.MOV', 'video/quicktime')).toBeNull();
    expect(correctExtension('clip.m4v', 'video/mp4')).toBeNull();
    expect(correctExtension('clip.mp4', 'video/x-m4v')).toBeNull();
  });

  it('swaps a mismatched extension for the canonical one of the detected type', () => {
    expect(correctExtension('clip.png', 'video/mp4')).toEqual({
      filename: 'clip.mp4',
      from: 'png',
      to: 'mp4',
    });
    expect(correctExtension('LINE_ALBUM.jpg', 'image/heic')?.filename).toBe('LINE_ALBUM.heic');
    expect(correctExtension('photo.final.JPG', 'image/png')?.filename).toBe('photo.final.png');
    expect(correctExtension('IMG_0002.mp4', 'video/quicktime')?.filename).toBe('IMG_0002.mov');
    expect(correctExtension('a.mov', 'video/3gpp2')?.filename).toBe('a.3gp');
  });

  it('does nothing for types outside the allowlist', () => {
    expect(correctExtension('a.jpg', 'application/pdf')).toBeNull();
    expect(correctExtension('a.jpg', 'unknown')).toBeNull();
  });

  it('only ever produces allowed extensions, for exactly the allowed types', () => {
    expect(new Set(Object.keys(EXTENSIONS_BY_MIME))).toEqual(ALLOWED_MIME_TYPES);
    for (const extensions of Object.values(EXTENSIONS_BY_MIME)) {
      for (const ext of extensions) expect(ALLOWED_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});

describe('scanStaging', () => {
  it('reads declared and received sizes of tus uploads from disk', async () => {
    const dir = path.join(TMP_ROOT, `scan-${crypto.randomUUID()}`);
    await fs.mkdir(path.join(dir, 'importing'), { recursive: true });
    const info = (size) => JSON.stringify({ size, metadata: {} });
    await fs.writeFile(path.join(dir, 'a.json'), info(100));
    await fs.writeFile(path.join(dir, 'a'), Buffer.alloc(40));
    await fs.writeFile(path.join(dir, 'b.json'), info(10)); // data already moved away
    await fs.writeFile(path.join(dir, 'c.json'), '{broken');
    await fs.writeFile(path.join(dir, 'd.json'), info(null)); // deferred length
    await fs.writeFile(path.join(dir, 'importing', 'e.json'), info(5)); // not top level
    try {
      expect(await scanStaging(dir)).toEqual(
        new Map([
          ['a', { size: 100, received: 40 }],
          ['b', { size: 10, received: null }],
        ]),
      );
      expect(await scanStaging(path.join(dir, 'missing'))).toEqual(new Map());
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
