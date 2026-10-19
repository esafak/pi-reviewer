/**
 * Built-in LSP server presets for CI reviews.
 *
 * Each entry mirrors the pi-lsp server-config file shape (which is plain
 * JSON: only the fields below are serialized into lsp.json). `installHint`
 * is ours alone — it feeds the missing-binary warning and is stripped before
 * writing. Everything else a user can override per id via `lsp-config-file`.
 *
 * No lint/format servers on purpose: LSP here is correctness signal only
 * (type errors, broken references, syntax errors), never style.
 */
export interface LspPresetServer {
  id: string;
  bin: string;
  args: string[];
  include: string[];
  rootMarkers: string[];
  languageIdByExtension: Record<string, string>;
  startupTimeoutMs: number;
  diagnosticsWaitMs: number;
  /** One-line install instruction for the missing-binary warning. Not serialized. */
  installHint: string;
}

const PRESETS: readonly LspPresetServer[] = [
  {
    id: "ty",
    bin: "ty",
    args: ["server"],
    include: ["**/*.py", "**/*.pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "uv.lock", ".git"],
    languageIdByExtension: { ".py": "python", ".pyi": "python" },
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 3000,
    installHint: "install ty (uv tool install ty / pip install ty)",
  },
  {
    id: "markdown-oxide",
    bin: "markdown-oxide",
    args: [],
    include: ["**/*.md", "**/*.markdown"],
    rootMarkers: [".git"],
    languageIdByExtension: { ".md": "markdown", ".markdown": "markdown" },
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 1500,
    installHint: "install markdown-oxide (cargo install markdown-oxide)",
  },
  {
    id: "rust-analyzer",
    bin: "rust-analyzer",
    args: [],
    include: ["**/*.rs"],
    rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
    languageIdByExtension: { ".rs": "rust" },
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 2000,
    installHint: "install rust-analyzer (rustup component add rust-analyzer)",
  },
  {
    id: "taplo",
    bin: "taplo",
    args: ["lsp", "stdio"],
    include: ["**/*.toml"],
    rootMarkers: [".taplo.toml", "taplo.toml", "Cargo.toml", "pyproject.toml", ".git"],
    languageIdByExtension: { ".toml": "toml" },
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
    include: ["**/*.go"],
    rootMarkers: ["go.work", "go.mod", ".git"],
    languageIdByExtension: { ".go": "go" },
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 2000,
    installHint: "install gopls (go install golang.org/x/tools/gopls@latest)",
  },
  {
    id: "tsc-rs",
    bin: "tsc-rs",
    args: ["--lsp", "-stdio"],
    include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rootMarkers: ["tsconfig.json", "package.json", ".git"],
    languageIdByExtension: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
    },
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 3000,
    installHint: "install tsc-rs (npm install -D tsc-rs)",
  },
  {
    id: "kotlin-lsp",
    bin: "kotlin-lsp",
    args: ["--stdio"],
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
    startupTimeoutMs: 45_000,
    diagnosticsWaitMs: 3000,
    installHint:
      "install kotlin-lsp (brew install JetBrains/utils/kotlin-lsp or download from https://github.com/Kotlin/kotlin-lsp/releases)",
  },
];

export const LSP_PRESET_IDS: readonly string[] = PRESETS.map((preset) => preset.id);

export function getLspPresets(): LspPresetServer[] {
  return PRESETS.map((preset) => ({
    ...preset,
    args: [...preset.args],
    include: [...preset.include],
    rootMarkers: [...preset.rootMarkers],
    languageIdByExtension: { ...preset.languageIdByExtension },
  }));
}

export function getLspPreset(id: string): LspPresetServer | undefined {
  return getLspPresets().find((preset) => preset.id === id);
}
