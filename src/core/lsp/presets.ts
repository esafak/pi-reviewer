/**
 * Built-in LSP servers for CI reviews, grouped per language.
 *
 * A group owns the file matching rules of one language; its candidates are
 * alternative servers for that language, listed in preference order. Among
 * installed candidates, the one that serves the most changed files is
 * selected, with preference order breaking ties. At most one candidate is
 * selected per group; none is selected when no candidate binary is available.
 *
 * A candidate carries only what makes it a different server (`bin`, `args`,
 * timeouts); everything else comes from the group, so the matching rules stay
 * one source of truth per language. A trusted config file can override any
 * field per candidate id.
 *
 * No lint/format servers on purpose: LSP here is correctness signal only
 * (type errors, broken references, syntax errors), never style.
 */

/** Languages with a built-in server group. Closed set: config files key on it. */
export type LspGroupId = "python" | "typescript" | "markdown" | "rust" | "toml" | "go" | "kotlin";

/** One server that can serve a language group. */
export interface LspCandidate {
  id: string;
  bin: string;
  args: string[];
  startupTimeoutMs: number;
  diagnosticsWaitMs: number;
  /** One-line install instruction for the missing-binary warning. Not serialized. */
  installHint: string;
}

/** One language: the file matching rules plus the servers that can serve it. */
export interface LspGroup {
  id: LspGroupId;
  include: string[];
  rootMarkers: string[];
  languageIdByExtension: Record<string, string>;
  /** Candidate ids in preference order, used to break ties in served changed-file coverage. */
  candidates: readonly string[];
}

const CANDIDATES: readonly LspCandidate[] = [
  {
    id: "ty",
    bin: "ty",
    args: ["server"],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 3000,
    installHint: "install ty (uv tool install ty / pip install ty)",
  },
  {
    id: "pyrefly",
    bin: "pyrefly",
    args: ["lsp"],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 3000,
    installHint: "install pyrefly (uv tool install pyrefly / pip install pyrefly)",
  },
  {
    id: "pyright",
    bin: "pyright-langserver",
    args: ["--stdio"],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 3000,
    installHint: "install pyright (npm install -D pyright / pip install pyright)",
  },
  {
    id: "tsrs",
    bin: "tsrs",
    args: ["--lsp", "-stdio"],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 3000,
    installHint: "install tsrs (npm install -D tsrs)",
  },
  {
    id: "tsc-rs",
    bin: "tsc-rs",
    args: ["--lsp", "-stdio"],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 3000,
    installHint: "install tsc-rs (npm install -D tsc-rs)",
  },
  {
    id: "typescript-language-server",
    bin: "typescript-language-server",
    args: ["--stdio"],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 3000,
    installHint:
      "install typescript-language-server (npm install -D typescript-language-server typescript)",
  },
  {
    id: "markdown-oxide",
    bin: "markdown-oxide",
    args: [],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 1500,
    installHint: "install markdown-oxide (cargo install markdown-oxide)",
  },
  {
    id: "rust-analyzer",
    bin: "rust-analyzer",
    args: [],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 2000,
    installHint: "install rust-analyzer (rustup component add rust-analyzer)",
  },
  {
    id: "taplo",
    bin: "taplo",
    args: ["lsp", "stdio"],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 1500,
    // The Taplo language server is behind the `lsp` cargo feature and is not
    // in the default or npm builds — the feature flag below is required.
    installHint: "install taplo with LSP support (cargo install taplo-cli --features lsp --locked)",
  },
  {
    id: "gopls",
    bin: "gopls",
    args: [],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 2000,
    installHint: "install gopls (go install golang.org/x/tools/gopls@latest)",
  },
  {
    id: "kotlin-lsp",
    bin: "kotlin-lsp",
    args: ["--stdio"],
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 3000,
    installHint:
      "install kotlin-lsp (brew install JetBrains/utils/kotlin-lsp or download from https://github.com/Kotlin/kotlin-lsp/releases)",
  },
];

const GROUPS: readonly LspGroup[] = [
  {
    id: "python",
    include: ["**/*.py", "**/*.pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "uv.lock", ".git"],
    languageIdByExtension: { ".py": "python", ".pyi": "python" },
    candidates: ["ty", "pyrefly", "pyright"],
  },
  {
    id: "typescript",
    include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rootMarkers: ["tsconfig.json", "package.json", ".git"],
    languageIdByExtension: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
    },
    candidates: ["tsrs", "tsc-rs", "typescript-language-server"],
  },
  {
    id: "markdown",
    include: ["**/*.md", "**/*.markdown"],
    rootMarkers: [".git"],
    languageIdByExtension: { ".md": "markdown", ".markdown": "markdown" },
    candidates: ["markdown-oxide"],
  },
  {
    id: "rust",
    include: ["**/*.rs"],
    rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
    languageIdByExtension: { ".rs": "rust" },
    candidates: ["rust-analyzer"],
  },
  {
    id: "toml",
    include: ["**/*.toml"],
    rootMarkers: [".taplo.toml", "taplo.toml", "Cargo.toml", "pyproject.toml", ".git"],
    languageIdByExtension: { ".toml": "toml" },
    candidates: ["taplo"],
  },
  {
    id: "go",
    include: ["**/*.go"],
    rootMarkers: ["go.work", "go.mod", ".git"],
    languageIdByExtension: { ".go": "go" },
    candidates: ["gopls"],
  },
  {
    id: "kotlin",
    include: ["**/*.kt", "**/*.kts"],
    rootMarkers: [
      "settings.gradle",
      "settings.gradle.kts",
      "build.gradle",
      "build.gradle.kts",
      "pom.xml",
      "workspace.json",
      ".git",
    ],
    languageIdByExtension: { ".kt": "kotlin", ".kts": "kotlin" },
    candidates: ["kotlin-lsp"],
  },
];

export const LSP_CANDIDATE_IDS: readonly string[] = CANDIDATES.map((candidate) => candidate.id);

export function isLspGroupId(id: string): id is LspGroupId {
  return GROUPS.some((group) => group.id === id);
}

export function getLspGroups(): LspGroup[] {
  return GROUPS.map((group) => ({
    ...group,
    include: [...group.include],
    rootMarkers: [...group.rootMarkers],
    languageIdByExtension: { ...group.languageIdByExtension },
    candidates: [...group.candidates],
  }));
}

export function getLspCandidate(id: string): LspCandidate | undefined {
  const candidate = CANDIDATES.find((entry) => entry.id === id);
  return candidate ? { ...candidate, args: [...candidate.args] } : undefined;
}
