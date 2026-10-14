import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export class JsonFileStateStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new TypeError('state file path must be a non-empty string');
    }
    this.filePath = path.resolve(filePath);
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new TypeError('persisted ScopeGuard state must be a JSON object');
    }
    return state;
  }

  async save(state) {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    let handle;
    try {
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, this.filePath);
      try {
        const directoryHandle = await open(directory, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (error) {
        // Windows does not consistently permit opening directories for fsync.
        if (!['EACCES', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
      }
    } finally {
      await handle?.close().catch(() => {});
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}
