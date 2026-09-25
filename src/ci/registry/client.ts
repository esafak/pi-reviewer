import {
  MAX_LOOKUPS,
  MAX_RESULT_BYTES,
  MAX_TOTAL_RESULT_BYTES,
  REQUEST_TIMEOUT_MS,
  resolveRegistryWallTimeBudgetMs,
} from "./helpers.js";
import { createRegistryProvider } from "./providers.js";
import type { RegistryClient } from "./types.js";
import { safePackageName, safeVersion } from "./helpers.js";

export function createRegistryClient(): RegistryClient {
  const started = Date.now();
  const wallTimeBudgetMs = resolveRegistryWallTimeBudgetMs();
  let lookupCount = 0;
  let outputBytes = 0;
  let nextCratesIoRequest = 0;

  return {
    async lookup(params) {
      if (!safePackageName(params.name)) throw new Error("Package name is invalid");
      if (params.version !== undefined && !safeVersion(params.version))
        throw new Error("Package version is invalid");
      if (Date.now() - started >= wallTimeBudgetMs)
        throw new Error("Registry wall-clock budget exhausted");
      if (lookupCount >= MAX_LOOKUPS) throw new Error("Registry lookup budget exhausted");
      if (params.ecosystem === "java" && params.name.split(":").length !== 2)
        throw new Error("Maven package name must be group:artifact");

      lookupCount++;
      const elapsed = Date.now() - started;
      const timeout = Math.min(REQUEST_TIMEOUT_MS, wallTimeBudgetMs - elapsed);
      const signal = AbortSignal.timeout(timeout);
      if (params.ecosystem === "rust") {
        const now = Date.now();
        const requestAt = Math.max(now, nextCratesIoRequest);
        nextCratesIoRequest = requestAt + 1_000;
        const wait = requestAt - now;
        if (wait > 0) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, wait);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("Registry request timed out"));
              },
              { once: true },
            );
          });
        }
      }
      const provider = createRegistryProvider(params.ecosystem);
      const metadata = await provider.lookup(params, signal);
      const bytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
      if (bytes > MAX_RESULT_BYTES) throw new Error("Registry result exceeded the byte limit");
      if (outputBytes + bytes > MAX_TOTAL_RESULT_BYTES)
        throw new Error("Registry aggregate output budget exhausted");
      outputBytes += bytes;
      return { metadata, remainingLookups: MAX_LOOKUPS - lookupCount };
    },
  };
}

export type { RegistryClient, RegistryLookupParams } from "./types.js";
