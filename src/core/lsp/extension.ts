import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

async function importPiLspModule(relativePath: string): Promise<Record<string, unknown>> {
  const require = createRequire(import.meta.url);
  let entry: string;
  try {
    entry = require.resolve(`pi-lsp/${relativePath}`);
  } catch {
    throw new Error("pi-lsp is not installed: LSP tools are unavailable.");
  }
  return (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
}

/**
 * Loads pi-lsp's extension setup function without a static import.
 *
 * pi-lsp ships TypeScript sources whose relative imports are not
 * NodeNext-clean, so they cannot be part of this repo's `tsc` program — but
 * tsx and vitest execute them fine. Resolve the entry at runtime (fail-fast
 * when the dependency is missing) and import it by file URL. The unknown-cast
 * below is the whole of the untyped boundary, mirroring the pi-mcp-adapter
 * dynamic import in `src/ci/review.ts`.
 */
export async function loadPiLspExtension(): Promise<ExtensionFactory> {
  const exported = await importPiLspModule("extensions/pi-lsp/index.ts");
  if (typeof exported.default !== "function") {
    throw new Error("pi-lsp did not export a default extension factory.");
  }
  return exported.default as ExtensionFactory;
}

/** Loads any other pi-lsp TypeScript source through the same untyped boundary. */
export async function loadPiLspModule(relativePath: string): Promise<Record<string, unknown>> {
  return importPiLspModule(relativePath);
}

/**
 * Partitions extension-registered tool names by origin. pi-lsp names every
 * tool `lsp_*`; anything else registered by an extension belongs to MCP.
 * The partition keeps LSP failures out of the MCP failure accounting
 * (`failedMcpCalls`, DeepWiki veto) in `src/ci/review.ts`.
 */
export function partitionExtensionTools(names: readonly string[]): {
  lsp: string[];
  mcp: string[];
} {
  const lsp = names.filter((name) => name.startsWith("lsp_"));
  const mcp = names.filter((name) => !name.startsWith("lsp_"));
  return { lsp, mcp };
}
