import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasControlCharacters, truncateUtf8WithMarker } from "../registry/helpers.js";

// Downloaded GitHub files live outside the review workspace so the local
// read/grep/find tools keep their trusted-workspace scope. Only github_grep
// scans this directory, and its results carry the same untrusted framing as
// every other research result.
export const MAX_CACHED_FILES = 50;
export const MAX_CACHED_BYTES = 5 * 1024 * 1024;
export const MAX_CACHED_FILE_BYTES = 1024 * 1024;
export const MAX_GREP_MATCHES = 50;

export function defaultCacheDir(): string {
  const override = process.env.PI_REVIEWER_GH_CACHE_DIR?.trim();
  if (override) return override;
  return path.join(tmpdir(), "pi-reviewer-gh-cache");
}

export interface CachedFileKey {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
}

function isValidKey(key: CachedFileKey): boolean {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(key.owner)) return false;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key.repo)) return false;
  if (
    key.ref !== undefined &&
    (key.ref.length === 0 ||
      key.ref.length > 256 ||
      hasControlCharacters(key.ref) ||
      key.ref.startsWith("-") ||
      key.ref.includes(".."))
  )
    return false;
  if (
    !key.path ||
    key.path.length > 1024 ||
    key.path.startsWith("-") ||
    key.path.includes("..") ||
    hasControlCharacters(key.path)
  )
    return false;
  return true;
}

function cacheFilePath(dir: string, key: CachedFileKey): string {
  const segments = key.path
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
  return path.join(dir, key.owner, key.repo, encodeURIComponent(key.ref ?? "default"), ...segments);
}

export function parseCacheKey(dir: string, file: string): CachedFileKey | undefined {
  const normalized = file.split("/").join(path.sep);
  const relative = path.relative(dir, normalized);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const parts = relative.split(path.sep);
  if (parts.length < 4) return undefined;
  const [owner, repo, encodedRef, ...encodedPath] = parts as [string, string, string, ...string[]];
  try {
    return {
      owner: owner!,
      repo: repo!,
      ref: decodeURIComponent(encodedRef!),
      path: encodedPath.map((segment) => decodeURIComponent(segment)).join("/"),
    };
  } catch {
    return undefined;
  }
}

// Absolute search root for a scope: descends only along the provided
// owner/repo/ref/path prefix so a partial scope can never address a sibling.
// The ref segment always mirrors the writer (cacheFilePath defaults it to
// "default"), and segments failing writer validation are skipped rather than
// encoded, so hostile input broadens to an unscannable-or-empty scope whose
// hits the key filter then rejects.
export function scopeSubpath(dir: string, scope: GrepScope): string {
  const parts = [dir];
  if (scope.owner !== undefined && /^[A-Za-z0-9-]{1,39}$/.test(scope.owner)) {
    parts.push(scope.owner);
    if (scope.repo !== undefined && /^[A-Za-z0-9_.-]{1,100}$/.test(scope.repo)) {
      parts.push(scope.repo);
      parts.push(
        scope.ref !== undefined && isSafeRef(scope.ref)
          ? encodeURIComponent(scope.ref)
          : encodeURIComponent("default"),
      );
      if (scope.path !== undefined && isSafePath(scope.path)) {
        for (const segment of scope.path.replace(/^\/+/, "").split("/").filter(Boolean))
          parts.push(encodeURIComponent(segment));
      }
    }
  }
  return path.join(...parts);
}

function isSafeRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 256 &&
    !hasControlCharacters(ref) &&
    !ref.startsWith("-") &&
    !ref.includes("..")
  );
}

function isSafePath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    filePath.length <= 1024 &&
    !filePath.startsWith("-") &&
    !filePath.includes("..") &&
    !hasControlCharacters(filePath)
  );
}

export function scopeMatchesKey(key: CachedFileKey, scope: GrepScope): boolean {
  if (scope.owner !== undefined && key.owner !== scope.owner) return false;
  if (scope.repo !== undefined && key.repo !== scope.repo) return false;
  if (scope.ref !== undefined && (key.ref ?? "default") !== scope.ref) return false;
  // Path scopes are prefix matches on segment boundaries so both exact files
  // and directories scope correctly, mirroring scopeSubpath's descent.
  // Slashes are normalized on both ends: "docs/" scopes like "docs".
  if (scope.path !== undefined) {
    const prefix = scope.path.replace(/^\/+|\/+$/gu, "");
    if (key.path !== prefix && !key.path.startsWith(`${prefix}/`)) return false;
  }
  return true;
}

export async function walkFiles(dir: string, files: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function enforceCaps(dir: string): Promise<void> {
  const files = await walkFiles(dir);
  if (files.length <= MAX_CACHED_FILES) {
    let total = 0;
    for (const file of files) {
      try {
        total += (await stat(file)).size;
      } catch {
        continue;
      }
    }
    if (total <= MAX_CACHED_BYTES) return;
  }
  const sized = [];
  for (const file of files) {
    try {
      sized.push({ file, mtime: (await stat(file)).mtimeMs, size: (await stat(file)).size });
    } catch {
      continue;
    }
  }
  // Evict oldest-first without skipping: entries are removed from a
  // snapshot list while the totals exceed either cap.
  const snapshot = sized.slice().sort((a, b) => a.mtime - b.mtime);
  let total = snapshot.reduce((sum, entry) => sum + entry.size, 0);
  let count = snapshot.length;
  for (const entry of snapshot) {
    if (count <= MAX_CACHED_FILES && total <= MAX_CACHED_BYTES) break;
    try {
      await rm(entry.file, { force: true });
      total -= entry.size;
      count -= 1;
    } catch {
      continue;
    }
  }
}

// The full download is cached for repeated greps; only a truncated preview
// reaches the model. Cache failures never fail the read itself.
export async function saveCachedFile(
  dir: string,
  key: CachedFileKey,
  content: string,
): Promise<void> {
  if (!isValidKey(key)) throw new Error("GitHub cache key is invalid");
  // A single download never exceeds the fetch ceiling; larger payloads are
  // rejected before reaching the cache so one file cannot evict everything.
  if (Buffer.byteLength(content) > MAX_CACHED_FILE_BYTES)
    throw new Error("GitHub cache file exceeds the byte limit");
  const file = cacheFilePath(dir, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  await enforceCaps(dir).catch(() => undefined);
}

export interface RangedRead {
  repository: string;
  ref?: string;
  path: string;
  content: string;
  size: number;
  totalLines: number;
  offset: number;
  limit: number;
  truncated: boolean;
}

export const MAX_RANGE_LINES = 200;
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

// Line ranges are served from the download cache so paging through a large
// file costs no additional gh requests. Entries are age-capped because
// unpinned refs track moving branch tips; pinned SHAs are immutable but share
// the same rule for a single code path.
export async function readCachedRange(
  dir: string,
  key: CachedFileKey,
  offset: number,
  limit: number,
): Promise<RangedRead | undefined> {
  if (
    !isValidKey(key) ||
    !Number.isInteger(offset) ||
    offset < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_RANGE_LINES
  )
    return undefined;
  const file = cacheFilePath(dir, key);
  try {
    const age = Date.now() - (await stat(file)).mtimeMs;
    if (age > CACHE_MAX_AGE_MS) return undefined;
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    const start = offset - 1;
    if (start >= lines.length) return undefined;
    // The slice observes the same 4 KiB model-facing cap as the fetch path;
    // minified single-line files must not widen the result budget on re-read.
    const rawSlice = lines.slice(start, start + limit).join("\n");
    const slice = truncateUtf8WithMarker(rawSlice, 4 * 1024);
    return {
      repository: `${key.owner}/${key.repo}`,
      ref: key.ref,
      path: key.path,
      content: slice,
      size: Buffer.byteLength(content),
      totalLines: lines.length,
      offset,
      limit,
      truncated: start > 0 || start + limit < lines.length || slice !== rawSlice,
    };
  } catch {
    return undefined;
  }
}

export interface GrepScope {
  owner?: string;
  repo?: string;
  ref?: string;
  path?: string;
}

export interface GrepHit {
  repository: string;
  ref?: string;
  path: string;
  line: number;
  text: string;
}
