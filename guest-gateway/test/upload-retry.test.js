// guest-gateway/test/upload-retry.test.js
// ブラウザ側のアップロード失敗の分類と自動再試行の間隔(public/upload-retry.js)のテスト。

import { Blob } from 'node:buffer';
import {
  AUTO_RETRY_DELAYS_MS,
  autoRetryDelay,
  canReadFile,
  classifyUploadError,
  fileKey,
  isPermanentFailure,
  isTransientFailure,
  isUnreadableFileError,
  MAX_STATUS_MISSES,
  nextStatusMisses,
} from '../public/upload-retry.js';

describe('upload failure classification', () => {
  it('treats network errors, 5xx and busy/conflict statuses as transient', () => {
    for (const status of [undefined, 0, 500, 502, 503, 504, 408, 409, 423, 429]) {
      expect(isTransientFailure(status), String(status)).toBe(true);
      expect(isPermanentFailure(status), String(status)).toBe(false);
    }
  });

  it('never retries what re-sending cannot fix', () => {
    for (const status of [400, 403, 404, 413, 415, 507]) {
      expect(isPermanentFailure(status), String(status)).toBe(true);
      expect(isTransientFailure(status), String(status)).toBe(false);
    }
  });

  it('leaves 401 to the re-login flow (neither permanent nor retried by itself)', () => {
    expect(isPermanentFailure(401)).toBe(false);
    expect(isTransientFailure(401)).toBe(false);
  });
});

describe('autoRetryDelay', () => {
  it('backs off and stays at the cap', () => {
    const mid = () => 0.5; // no jitter
    expect(autoRetryDelay(0, mid)).toBe(AUTO_RETRY_DELAYS_MS[0]);
    expect(autoRetryDelay(1, mid)).toBe(AUTO_RETRY_DELAYS_MS[1]);
    const cap = AUTO_RETRY_DELAYS_MS.at(-1);
    expect(autoRetryDelay(AUTO_RETRY_DELAYS_MS.length - 1, mid)).toBe(cap);
    expect(autoRetryDelay(50, mid)).toBe(cap);
  });

  it('adds at most ±20% jitter', () => {
    expect(autoRetryDelay(0, () => 0)).toBe(AUTO_RETRY_DELAYS_MS[0] * 0.8);
    expect(autoRetryDelay(0, () => 0.999999)).toBeLessThanOrEqual(AUTO_RETRY_DELAYS_MS[0] * 1.2);
  });
});

// Shapes of tus-js-client 4.x errors: DetailedError carries originalRequest/originalResponse
// when an HTTP request was involved; other errors (storage, setup) carry neither.
const httpError = (status) => ({
  originalRequest: {},
  originalResponse: status === undefined ? null : { getStatus: () => status },
});

describe('classifyUploadError', () => {
  it('sorts HTTP failures like the status rules', () => {
    expect(classifyUploadError(httpError(410)).kind).toBe('closed');
    expect(classifyUploadError(httpError(413))).toEqual({ kind: 'permanent', status: 413 });
    expect(classifyUploadError(httpError(507)).kind).toBe('permanent');
    expect(classifyUploadError(httpError(401))).toEqual({ kind: 'login', status: 401 });
    expect(classifyUploadError(httpError(503)).kind).toBe('transient');
    expect(classifyUploadError(httpError(429)).kind).toBe('transient');
  });

  it('treats a request without a response as a network error while the file is readable', () => {
    expect(classifyUploadError(httpError(undefined))).toEqual({
      kind: 'transient',
      status: undefined,
    });
    expect(classifyUploadError(httpError(undefined), { fileReadable: true }).kind).toBe(
      'transient',
    );
  });

  it('never retries a file the browser cannot read', () => {
    expect(classifyUploadError(httpError(undefined), { fileReadable: false }).kind).toBe(
      'unreadable',
    );
    // Not from an HTTP request at all (tus reports those without originalRequest).
    const notReadable = Object.assign(new Error('read failed'), { name: 'NotReadableError' });
    expect(classifyUploadError(notReadable).kind).toBe('unreadable');
    expect(classifyUploadError(new Error('tus: something local')).kind).toBe('unreadable');
    // Wrapped by tus as causingError of a request error.
    const wrapped = { ...httpError(undefined), causingError: { name: 'NotFoundError' } };
    expect(classifyUploadError(wrapped).kind).toBe('unreadable');
  });

  it('keeps the closed page first even when the file is gone', () => {
    expect(classifyUploadError(httpError(410), { fileReadable: false }).kind).toBe('closed');
  });
});

describe('isUnreadableFileError', () => {
  it('looks through causingError', () => {
    expect(isUnreadableFileError({ name: 'NotReadableError' })).toBe(true);
    const nested = { causingError: { causingError: { name: 'NotFoundError' } } };
    expect(isUnreadableFileError(nested)).toBe(true);
    expect(isUnreadableFileError({ name: 'TypeError' })).toBe(false);
    expect(isUnreadableFileError(null)).toBe(false);
  });
});

describe('canReadFile', () => {
  it('reads the first byte of a readable file', async () => {
    expect(await canReadFile(new Blob(['abc']))).toBe(true);
    expect(await canReadFile(new Blob([]))).toBe(true);
  });

  it('reports a file whose data is gone', async () => {
    const gone = {
      slice: () => ({
        arrayBuffer: () =>
          Promise.reject(Object.assign(new Error('gone'), { name: 'NotReadableError' })),
      }),
    };
    expect(await canReadFile(gone)).toBe(false);
  });
});

describe('fileKey', () => {
  it('identifies a file by name, size and modification time', () => {
    const a = { name: 'IMG_1.HEIC', size: 10, lastModified: 1 };
    expect(fileKey(a)).toBe(fileKey({ ...a }));
    expect(fileKey(a)).not.toBe(fileKey({ ...a, lastModified: 2 }));
    expect(fileKey(a)).not.toBe(fileKey({ ...a, size: 11 }));
  });
});

describe('nextStatusMisses', () => {
  it('gives up after MAX_STATUS_MISSES answers in a row without the upload', () => {
    let misses = 0;
    for (let i = 1; i < MAX_STATUS_MISSES; i += 1) {
      const step = nextStatusMisses(misses, false);
      expect(step.giveUp).toBe(false);
      misses = step.misses;
    }
    expect(nextStatusMisses(misses, false).giveUp).toBe(true);
  });

  it('starts over when the upload is listed again', () => {
    expect(nextStatusMisses(4, true)).toEqual({ misses: 0, giveUp: false });
  });
});
