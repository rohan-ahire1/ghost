import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {}
}

/**
 * Shared private atomic JSON writer.
 * - same-directory unique random temp (basename + pid + timestamp + random)
 * - mode 0600 for temp and destination
 * - best-effort file fsync before rename
 * - atomic rename
 * - destination chmod 0600
 * - best-effort directory fsync
 * - temp cleanup on failure
 * Keeps directory mode 0700.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  ensureDir(dir);
  const base = basename(filePath);
  const tmp = join(dir, `.${base}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}`);
  const content = JSON.stringify(data, null, 2);
  let fd: number | undefined;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {}
    try {
      fd = openSync(tmp, "r");
      fsyncSync(fd);
    } catch {}
    finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
        fd = undefined;
      }
    }
    renameSync(tmp, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {}
    try {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } catch {}
      finally {
        try {
          closeSync(dirFd);
        } catch {}
      }
    } catch {}
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    throw e;
  }
}
