import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function chmodBestEffort(targetPath: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }

  try {
    chmodSync(targetPath, mode);
  } catch {
    // Keep startup resilient if the filesystem does not support POSIX modes.
  }
}

export function ensurePrivateDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodBestEffort(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateFile(filePath: string): void {
  chmodBestEffort(filePath, PRIVATE_FILE_MODE);
}

export function writePrivateFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tmpPath, data, { mode: PRIVATE_FILE_MODE });
    renameSync(tmpPath, filePath);
    ensurePrivateFile(filePath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

// Timestamped snapshot naming for pre-swap backups of a live credential file:
// `host-auth.<timestamp>.json`. The timestamp is fixed-width, so plain
// lexicographic sorting of these filenames is also chronological.
const BACKUP_FILENAME_PREFIX = "host-auth.";
const BACKUP_FILENAME_SUFFIX = ".json";

// Copy `sourcePath` into `backupDir` as `host-auth.<timestamp>.json`, written
// atomically with 0600 perms into a 0700 directory (reusing
// `writePrivateFileAtomicSync`). The source is read as raw bytes so a credential
// snapshot round-trips byte-verbatim. Returns the new backup path.
//
// The caller supplies `timestamp` (e.g. `new Date().toISOString()` with `:`
// replaced for Windows-safe filenames) so this helper stays pure and testable;
// it is otherwise domain-agnostic and knows nothing about grok.
export function backupFileToDir(sourcePath: string, backupDir: string, timestamp: string): string {
  ensurePrivateDirectory(backupDir);
  const destPath = path.join(
    backupDir,
    `${BACKUP_FILENAME_PREFIX}${timestamp}${BACKUP_FILENAME_SUFFIX}`,
  );
  writePrivateFileAtomicSync(destPath, readFileSync(sourcePath));
  return destPath;
}

// Prune `host-auth.*.json` snapshots in `backupDir`: keep the newest `keep`
// (filenames sort newest-first because the embedded timestamp is fixed-width),
// PLUS any filename the injected `isProtected` predicate marks. Everything else
// is removed best-effort. The predicate is how a caller preserves a snapshot
// that would otherwise be the only recoverable copy of some state — this helper
// itself inspects no file contents, so protection policy lives entirely in the
// caller. A missing `backupDir` is a no-op.
export function prunePrivateBackups(
  backupDir: string,
  keep: number,
  isProtected: (filename: string) => boolean,
): void {
  let filenames: string[];
  try {
    filenames = readdirSync(backupDir);
  } catch {
    return;
  }
  const backupsNewestFirst = filenames
    .filter(
      (name) => name.startsWith(BACKUP_FILENAME_PREFIX) && name.endsWith(BACKUP_FILENAME_SUFFIX),
    )
    // Descending sort (newest-timestamp filename first) via localeCompare —
    // avoids `.reverse()` (lint no-array-reverse) and `.toReversed()` (not in
    // the build's ES2022 lib).
    .sort((a, b) => b.localeCompare(a));
  for (const name of backupsNewestFirst.slice(Math.max(0, keep))) {
    if (isProtected(name)) {
      continue;
    }
    rmSync(path.join(backupDir, name), { force: true });
  }
}
