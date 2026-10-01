// guest-gateway/test/requeue-failed.test.js
// 失敗分の復旧スクリプト: 既定は確認のみで何も変えない、--apply で failed/ のファイルを importing/ に戻して
// 取り込み待ちにする(ファイルが無いものは失敗のまま)、戻した分は取り込みキューの再開で取り込まれる。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { formatRequeue, runCli } from '../scripts/requeue-failed.js';
import { createImporter } from '../src/importer.js';
import { openStore } from '../src/store.js';
import { FAILED_DIR_NAME, IMPORT_DIR_NAME } from '../src/uploads.js';
import { TMP_ROOT } from './helpers/server.js';

const ASSET_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('requeue-failed script', () => {
  let root;
  let stagingDir;
  let env;
  let output;

  const log = (msg) => output.push(msg);
  const inDir = (dirName) => fs.readdir(path.join(stagingDir, dirName)).then((n) => n.sort());

  function addRow(store, uploadId) {
    store.add({
      uploadId,
      deviceId: 'dev-1',
      nickname: 'たろう',
      filename: `${uploadId}.jpg`,
      mime: 'image/jpeg',
      size: 5,
      lastModified: null,
    });
  }

  beforeEach(async () => {
    root = path.join(TMP_ROOT, `requeue-${crypto.randomUUID()}`);
    stagingDir = path.join(root, 'staging');
    await fs.mkdir(path.join(stagingDir, FAILED_DIR_NAME), { recursive: true });
    await fs.mkdir(path.join(stagingDir, IMPORT_DIR_NAME), { recursive: true });
    env = { DB_PATH: path.join(root, 'gateway.db'), STAGING_DIR: stagingDir };
    output = [];

    // inFailed: the normal case. inImporting: the move to failed/ had failed. gone: no file.
    // done: imported, must not be touched.
    const store = openStore(env.DB_PATH);
    for (const id of ['inFailed', 'inImporting', 'gone', 'done']) {
      addRow(store, id);
      store.addAttempt(id);
    }
    for (const id of ['inFailed', 'inImporting', 'gone']) store.markFailed(id);
    store.markImported('done', 'created', ASSET_ID);
    store.close();
    await fs.writeFile(path.join(stagingDir, FAILED_DIR_NAME, 'inFailed'), 'bytes');
    await fs.writeFile(path.join(stagingDir, IMPORT_DIR_NAME, 'inImporting'), 'bytes');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('only reports by default (ids and counts, no names) and changes nothing', async () => {
    const items = await runCli([], env, { log });
    expect(items.map((i) => [i.id, i.location, i.result])).toEqual([
      ['inFailed', 'failed', null],
      ['inImporting', 'importing', null],
      ['gone', 'missing', null],
    ]);
    const text = output.join('\n');
    expect(text).toMatch(/取り込みに失敗: 3件/);
    expect(text).toMatch(/--apply/);
    expect(text).not.toMatch(/たろう|\.jpg/);

    const store = openStore(env.DB_PATH, { readOnly: true });
    expect(store.listFailed()).toHaveLength(3);
    store.close();
    expect(await inDir(FAILED_DIR_NAME)).toEqual(['inFailed']);
  });

  it('--apply moves files back, resets their rows and leaves rows without a file failed', async () => {
    const items = await runCli(['--apply'], env, { log });
    expect(items.map((i) => [i.id, i.result])).toEqual([
      ['inFailed', 'requeued'],
      ['inImporting', 'requeued'],
      ['gone', null],
    ]);
    expect(output.join('\n')).toMatch(/取り込み待ちに戻した: 2件/);
    expect(await inDir(FAILED_DIR_NAME)).toEqual([]);
    expect(await inDir(IMPORT_DIR_NAME)).toEqual(['inFailed', 'inImporting']);

    // What the gateway does on its next start.
    const store = openStore(env.DB_PATH);
    expect(store.get('inFailed')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(store.get('gone').status).toBe('failed');
    expect(store.get('done').status).toBe('created');
    const importer = createImporter({
      store,
      immich: { uploadAsset: async () => ({ status: 'created', id: ASSET_ID }) },
      dir: path.join(stagingDir, IMPORT_DIR_NAME),
      failedDir: path.join(stagingDir, FAILED_DIR_NAME),
    });
    expect(importer.resume()).toBe(2);
    await importer.idle();
    expect(store.get('inFailed').status).toBe('created');
    expect(store.get('inImporting').status).toBe('created');
    expect(await inDir(IMPORT_DIR_NAME)).toEqual([]);
    store.close();
  });

  it('refuses to run without the container environment or a database', async () => {
    await expect(runCli([], {}, { log })).rejects.toThrow(/DB_PATH and STAGING_DIR/);
    const missing = { ...env, DB_PATH: path.join(root, 'none.db') };
    await expect(runCli(['--apply'], missing, { log })).rejects.toThrow(/cannot open/);
    await expect(fs.stat(missing.DB_PATH)).rejects.toThrow();
  });

  it('says so when nothing failed', () => {
    expect(formatRequeue([], { apply: false })).toEqual(['取り込みに失敗したファイルはありません']);
  });
});
