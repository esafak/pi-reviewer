import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
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
