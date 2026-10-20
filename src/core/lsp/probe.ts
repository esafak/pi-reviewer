import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { LspFileServer } from "./config.js";
import { presetInstallHint } from "./config.js";
import { loadPiLspModule } from "./extension.js";
import type { LspServerRoot } from "./roots.js";

export interface LspBinaryProbe {
  id: string;
  bin: string;
  found: boolean;
  installHint?: string;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(bin: string, pathValue: string): string[] {
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  const candidates: string[] = [];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      candidates.push(path.join(entry, `${bin}${extension}`));
    }
  }
  return candidates;
}

/**
 * Final executable check, mirroring pi-lsp's `findExecutable`: absolute and
 * slash-containing paths are checked directly, bare names are searched on
 * PATH. Takes the already-resolved binary (placeholders expanded,
 * root-relative paths anchored — see below).
 */
export function findLspBinary(
  bin: string,
  pathValue: string = process.env.PATH ?? "",
): string | undefined {
  if (!bin.trim()) return undefined;
  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return isExecutable(bin) ? bin : undefined;
  }
  return pathCandidates(bin, pathValue).find(isExecutable);
}

interface PiLspResolver {
  resolveCommand(
    id: string,
    command: {
      bin: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      config?: string;
      timeoutMs?: number;
    },
    options: ResolveCommandOptions,
  ): { bin: string };
}

/**
 * Checks each configured server binary the way pi-lsp will actually spawn
 * it: the configured `bin` is resolved per matched workspace root through
 * pi-lsp's own `resolveCommand` (placeholder expansion, root anchoring),
 * then the resolved path is checked. Servers with no matched files resolve
 * against the checkout dir. Missing binaries warn-and-skip at review time;
 * nothing here installs or fails the run.
 */
/** The place a command is resolved for: a workspace, a root, and a file. */
interface ResolveCommandOptions {
  workspace: string;
  root: string;
  file: string;
}
/** The checkout, the roots, and the path the server is resolved for. */
interface ProbeServerOptions {
  cwd: string;
  roots: readonly LspServerRoot[];
  pathValue?: string;
}

export async function probeServerBinaries(
  entries: readonly LspFileServer[],
  options: ProbeServerOptions,
): Promise<LspBinaryProbe[]> {
  const { resolveCommand } = (await loadPiLspModule("extensions/_shared/paths.ts")) as unknown as {
    resolveCommand: PiLspResolver["resolveCommand"];
  };
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  return entries.map((entry) => {
    const roots = options.roots.filter((match) => match.id === entry.id);
    // Files arrive checkout-relative; resolveCommand interprets relative
    // `file` values against the selected root, so absolutize against the
    // checkout first — otherwise a nested root doubles the path segment
    // (/repo/sub + sub/a.x) and {{dir}}/{{file}} templates mis-resolve.
    const resolveFor = (root: string, file: string | undefined) =>
      resolveCommand(entry.id, entry, {
        workspace: options.cwd,
        root,
        file: file === undefined ? root : path.resolve(options.cwd, file),
      }).bin;
    const resolved =
      roots.length > 0
        ? roots.map((match) => resolveFor(match.root, match.files[0]))
        : [resolveFor(options.cwd, undefined)];
    const found = resolved.some((bin) => findLspBinary(bin, pathValue) !== undefined);
    return {
      id: entry.id,
      bin: entry.bin,
      found,
      installHint: found ? undefined : presetInstallHint(entry.id),
    };
  });
}
