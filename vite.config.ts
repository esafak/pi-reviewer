import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Keep formatting scoped to code, matching the pre-commit glob. Oxfmt
    // delegates these formats to Prettier: it rewrites HTML (doctype case, void
    // elements) and reflows inline <script> JS, corrupting the
    // `/*%%DATA%%*/null/*%%END%%*/` build marker in ui/index.html and
    // dist-ui/index.html. Upstream: oxc-project/oxc#24645 (doctype/void,
    // closed as Prettier delegation) and #16608 (js-in-html umbrella). JSON,
    // JSON5, YAML, TOML, Markdown, and CSS are also formatted by vp fmt, so
    // exclude them to stay code-only.
    ignorePatterns: [
      "dist/**",
      "dist-ui/**",
      "**/*.md",
      "**/*.html",
      "**/*.css",
      "**/*.json",
      "**/*.json5",
      "**/*.yml",
      "**/*.yaml",
      "**/*.toml",
    ],
  },
  lint: {
    ignorePatterns: ["dist/**", "dist-ui/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: false, typeCheck: false },
  },
  test: {
    exclude: ["dist/**", "node_modules/**"],
  },
});
