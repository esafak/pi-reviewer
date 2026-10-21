import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { LspFileServer, LspGroupPlan } from "./config.js";
import { lspInstallHint } from "./config.js";
import { loadPiLspModule } from "./extension.js";
import type { LspGroupId } from "./presets.js";
import type { LspServerRoot } from "./roots.js";

export interface LspBinaryProbe {
  id: string;
  bin: string;
  /** The binary was found in at least one workspace root. */
  found: boolean;
  /** The changed files this server can serve: those in roots with the binary. */
  servedFiles: string[];
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
        ? roots.map((match) => ({ root: match.root, bin: resolveFor(match.root, match.files[0]) }))
        : [{ root: options.cwd, bin: resolveFor(options.cwd, undefined) }];
    const missingRoots = resolved
      .filter((resolvedBin) => findLspBinary(resolvedBin.bin, pathValue) === undefined)
      .map((resolvedBin) => resolvedBin.root);
    const found = missingRoots.length < resolved.length;
    return {
      id: entry.id,
      bin: entry.bin,
      found,
      // A file is served only when the server can start in the root that
      // holds it.
      servedFiles: roots
        .filter((match) => !missingRoots.includes(match.root))
        .flatMap((match) => match.files),
      installHint: found ? undefined : lspInstallHint(entry.id),
    };
  });
}

/** The server a language group ended up with. */
export interface LspGroupPick {
  group: LspGroupId;
  /** The candidate that serves the group, when one was available. */
  entry?: LspFileServer;
}

/**
 * Picks one server per language group. Two servers for one language would
 * report on the same files, so the group gets at most one.
 *
 * The candidate that serves the most of the language's files wins, because
 * availability alone is not coverage: a server installed in one workspace
 * root serves only that root's files, and a server matched to no file at all
 * serves none. Ties keep the group's preference order.
 */
export function pickGroupServers(
  groups: readonly LspGroupPlan[],
  probes: readonly LspBinaryProbe[],
): LspGroupPick[] {
  const byId = new Map(probes.map((probe) => [probe.id, probe]));
  const installed = (candidate: LspFileServer) => byId.get(candidate.id)?.found === true;
  const served = (candidate: LspFileServer) => byId.get(candidate.id)?.servedFiles.length ?? 0;
  return groups.map((group) => {
    // Stable sort: candidates of equal coverage keep the group's preference
    // order.
    const ranked = group.candidates.filter(installed).sort((a, b) => served(b) - served(a));
    return {
      group: group.group.id,
      entry: ranked[0],
    };
  });
}
