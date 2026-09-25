export const MAX_RESPONSE_BYTES = 1_048_576;
// Reserve space for the tool's untrusted-data framing within the model-facing caps.
export const MAX_RESULT_BYTES = 7 * 1024;
export const MAX_TOTAL_RESULT_BYTES = 15 * 1024;
export const MAX_TOOL_CONTENT_BYTES = 8 * 1024;
export const MAX_LOOKUPS = 5;
export const REQUEST_TIMEOUT_MS = 8_000;
export const DEFAULT_WALL_TIME_BUDGET_MS = 15_000;
export const MIN_WALL_TIME_BUDGET_MS = 1_000;
export const MAX_WALL_TIME_BUDGET_MS = 120_000;

export function resolveRegistryWallTimeBudgetMs(
  raw = process.env.PI_REVIEWER_REGISTRY_WALL_TIME_BUDGET_MS,
): number {
  if (!raw?.trim()) return DEFAULT_WALL_TIME_BUDGET_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return DEFAULT_WALL_TIME_BUDGET_MS;
  return Math.max(MIN_WALL_TIME_BUDGET_MS, Math.min(MAX_WALL_TIME_BUDGET_MS, value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function boundedString(value: unknown, max = 500): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

export function boundedStrings(
  value: unknown,
  maxItems = 20,
  maxString = 300,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxString));
}

export async function responseJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Registry response exceeded the byte limit");
  }
  if (!response.body) throw new Error("Registry response body is empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Registry response exceeded the byte limit");
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Registry returned invalid JSON");
  }
}

export async function requestJson(
  url: URL,
  signal: AbortSignal,
  headers?: HeadersInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { accept: "application/json", ...headers },
    });
  } catch {
    if (signal.aborted) throw new Error("Registry request timed out");
    throw new Error("Registry request failed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Registry request failed: ${response.status}`);
  }
  return responseJson(response);
}

export function boundedRecord(
  value: unknown,
  fields: Record<string, (value: unknown) => unknown>,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Registry response has an invalid shape");
  const output: Record<string, unknown> = {};
  for (const [field, project] of Object.entries(fields)) {
    const projected = project(value[field]);
    if (projected !== undefined) output[field] = projected;
  }
  return output;
}

export function optionalString(max = 500): (value: unknown) => unknown {
  return (value) => boundedString(value, max);
}

export function optionalNumber(value: unknown): unknown {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalBoolean(value: unknown): unknown {
  return typeof value === "boolean" ? value : undefined;
}

export function optionalStringArray(maxItems = 20, maxString = 300): (value: unknown) => unknown {
  return (value) => boundedStrings(value, maxItems, maxString);
}

export function nestedProjection(
  value: unknown,
  fields: Record<string, (value: unknown) => unknown>,
): unknown {
  if (value === undefined || value === null) return value;
  return boundedRecord(value, fields);
}

export function boundedArray<T>(
  value: unknown,
  max: number,
  project: (value: unknown) => T,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, max).map(project);
}

export function safePackageName(name: string): boolean {
  return name.length > 0 && name.length <= 256 && !hasControlCharacters(name);
}

export function safeVersion(version: string): boolean {
  return version.length > 0 && version.length <= 256 && !hasControlCharacters(version);
}

export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}
