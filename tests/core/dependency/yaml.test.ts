import { describe, expect, it } from "vite-plus/test";

import {
  collectEntries,
  findEntry,
  readYamlDocument,
  scalarText,
} from "../../../src/core/dependency/yaml.js";

describe("readYamlDocument", () => {
  it("reads a mapping with nested mappings and sequences", () => {
    const document = readYamlDocument(
      [
        "name: CI",
        "on:",
        "  push:",
        "    branches:",
        "      - main",
        "      - release",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
      ].join("\n"),
    );
    expect(document.uncertain).toBe(false);
    expect(document.errors).toEqual([]);
    const name = findEntry(document.root, "name");
    expect(scalarText(name?.value)).toBe("CI");
    const branches = findEntry(
      findEntry(findEntry(document.root, "on")?.value, "push")?.value,
      "branches",
    );
    expect(branches?.value.kind).toBe("sequence");
    if (branches?.value.kind === "sequence") {
      expect(branches.value.items.map((item) => scalarText(item))).toEqual(["main", "release"]);
    }
  });

  it("reads a sequence of mappings", () => {
    const document = readYamlDocument(
      ["packages:", "  - name: cli/cli", "    version: v2.0.0", "  - name: other/tool"].join("\n"),
    );
    const packages = findEntry(document.root, "packages")?.value;
    expect(packages?.kind).toBe("sequence");
    if (packages?.kind !== "sequence") return;
    expect(packages.items).toHaveLength(2);
    expect(scalarText(findEntry(packages.items[0], "name")?.value)).toBe("cli/cli");
    expect(scalarText(findEntry(packages.items[0], "version")?.value)).toBe("v2.0.0");
    expect(scalarText(findEntry(packages.items[1], "name")?.value)).toBe("other/tool");
  });

  it.each([
    ["a space", " "],
    ["a tab", "\t"],
  ])("keeps the comment that trails a value, separated by %s", (_name, separator) => {
    const document = readYamlDocument(
      ["steps:", `  - uses: actions/checkout@abc123${separator}# v4.6.2`].join("\n"),
    );
    const [entry] = collectEntries(document.root, "uses");
    expect(scalarText(entry?.value)).toBe("actions/checkout@abc123");
    expect(entry?.value.kind === "scalar" ? entry.value.comment : undefined).toBe("v4.6.2");
  });

  it.each([
    ["single quotes", "name", "name: 'a: b'", "a: b"],
    ["double quotes", "other", 'other: "c\\"d"', 'c"d'],
  ])("reads a quoted scalar and leaves its text literal, in %s", (_name, key, value, expected) => {
    const document = readYamlDocument(value);
    expect(scalarText(findEntry(document.root, key)?.value)).toBe(expected);
  });

  it("reads a block scalar and does not read its content as a mapping", () => {
    const document = readYamlDocument(
      ["run: |", "  echo hello", "  uses: not/an-action@v1"].join("\n"),
    );
    expect(scalarText(findEntry(document.root, "run")?.value)).toContain("echo hello");
    expect(collectEntries(document.root, "uses")).toHaveLength(0);
  });

  it("reads a document with blank lines and comments between its entries", () => {
    const document = readYamlDocument(
      [
        "# a header comment",
        "",
        "name: CI",
        "",
        "# what the workflow does",
        "steps:",
        "  - uses: actions/checkout@v4.6.2",
        "",
        "  # a comment inside a sequence",
        "  - uses: actions/setup-node@v4.0.0",
      ].join("\n"),
    );
    expect(document.uncertain).toBe(false);
    expect(document.errors).toEqual([]);
    const uses = collectEntries(document.root, "uses");
    expect(uses).toHaveLength(2);
    expect(scalarText(uses[0]?.value)).toBe("actions/checkout@v4.6.2");
    expect(scalarText(uses[1]?.value)).toBe("actions/setup-node@v4.0.0");
  });

  it("reads a workflow written with carriage returns", () => {
    const document = readYamlDocument(
      ["name: CI", "steps:", "  - uses: actions/checkout@v4.6.2"].join("\r\n"),
    );
    expect(document.uncertain).toBe(false);
    expect(collectEntries(document.root, "uses")).toHaveLength(1);
  });

  it("reads the constructs a workflow really holds", () => {
    const document = readYamlDocument(
      [
        "name: CI",
        "on:",
        "  pull_request:",
        "    branches: [main]",
        "env:",
        "  NODE_VERSION: '24'",
        "jobs:",
        "  build:",
        "    runs-on: ${{ matrix.os }}",
        "    strategy:",
        "      matrix:",
        "        os: [ubuntu-latest, macos-latest]",
        "    steps:",
        "      - uses: actions/checkout@v4.6.2",
        "      - name: Run",
        "        run: |",
        '          echo "hello: world"',
        "          npm ci",
        "      - if: ${{ github.event_name == 'push' }}",
        "        run: echo done",
      ].join("\n"),
    );
    expect(document.uncertain).toBe(false);
    expect(collectEntries(document.root, "uses")).toHaveLength(1);
  });

  it.each([
    ["an anchor", "defaults", "defaults: &defaults\n  run:\n    shell: bash"],
    ["an alias", "other", "defaults: &defaults\n  shell: bash\nother: *defaults"],
    ["a tag", "tagged", "tagged: !!str hello"],
    ["a flow collection", "branches", "branches: [main, release]"],
  ])("reports %s as read but not interpreted", (_name, key, value) => {
    const document = readYamlDocument(
      [value, "jobs:", "  build:", "    - uses: actions/checkout@v4"].join("\n"),
    );
    expect(document.uncertain).toBe(false);
    expect(document.warnings.join("\n")).toContain("is not read");
    // The construct's contents are not read, and the declarations around it
    // survive.
    const entry = findEntry(document.root, key);
    expect(entry?.value.kind).toBe("scalar");
    expect(entry?.value.kind === "scalar" ? entry.value.unread : undefined).toBe(true);
    expect(collectEntries(document.root, "uses")).toHaveLength(1);
  });

  it("trusts nothing in a document with a syntax error", () => {
    const document = readYamlDocument(["name: CI", "not a mapping entry"].join("\n"));
    expect(document.uncertain).toBe(true);
    expect(document.errors.length).toBeGreaterThan(0);
  });

  it("trusts nothing in a document whose flow value is never closed", () => {
    const document = readYamlDocument(["uses: actions/checkout@v4", "other: [unclosed"].join("\n"));
    expect(document.uncertain).toBe(true);
  });

  it("trusts nothing in a document whose flow value does not close", () => {
    const document = readYamlDocument(["uses: actions/checkout@v4", "other: [}"].join("\n"));
    expect(document.uncertain).toBe(true);
  });

  it("trusts nothing in a document whose flow value has trailing content", () => {
    const document = readYamlDocument(
      ["uses: actions/checkout@v4", "other: [] garbage"].join("\n"),
    );
    expect(document.uncertain).toBe(true);
  });

  it.each([
    ["an empty flow entry", "[a,,b]"],
    ["a duplicated flow key", "{a: 1, a: 2}"],
    ["an unclosed flow string", "['unclosed]"],
  ])("trusts nothing in a document whose flow value has %s", (_name, value) => {
    const document = readYamlDocument(["uses: actions/checkout@v4", `other: ${value}`].join("\n"));
    expect(document.uncertain).toBe(true);
  });

  it("trusts nothing in a document whose value carries a mapping separator", () => {
    const document = readYamlDocument(["uses: actions/checkout@v4", "other: abc: def"].join("\n"));
    expect(document.uncertain).toBe(true);
  });

  it("trusts nothing in a document whose block header is not one it reads", () => {
    const document = readYamlDocument(
      ["uses: actions/checkout@v4", "run: |garbage", "  hi"].join("\n"),
    );
    expect(document.uncertain).toBe(true);
  });

  it("trusts nothing in a document whose alias has no name", () => {
    const document = readYamlDocument(["uses: actions/checkout@v4", "other: *"].join("\n"));
    expect(document.uncertain).toBe(true);
  });

  it("trusts nothing in a document whose alias carries a value", () => {
    const document = readYamlDocument(["uses: *u actions/checkout@v4"].join("\n"));
    expect(document.uncertain).toBe(true);
  });

  it("trusts nothing in a document whose block is not indented consistently", () => {
    const document = readYamlDocument(["uses: |", "    actions/checkout@v4", "  xx"].join("\n"));
    expect(document.uncertain).toBe(true);
  });

  it("trusts nothing in a document that nests beyond its depth limit", () => {
    const lines: string[] = [];
    for (let depth = 0; depth < 200; depth += 1) {
      lines.push(`${" ".repeat(depth * 2)}key:`);
    }
    lines.push(`${" ".repeat(200 * 2)}value`);
    const document = readYamlDocument(lines.join("\n"));
    expect(document.uncertain).toBe(true);
  });

  it("trusts nothing in a compact sequence that nests beyond its depth limit", () => {
    const document = readYamlDocument(`${"- ".repeat(500)}foo`);
    expect(document.uncertain).toBe(true);
  });

  it("reports a key that is declared twice", () => {
    const document = readYamlDocument(["name: CI", "name: CD"].join("\n"));
    expect(document.uncertain).toBe(true);
  });

  it("reports an indentation with a tab", () => {
    const document = readYamlDocument(["jobs:", "\tbuild: {}"].join("\n"));
    expect(document.uncertain).toBe(true);
  });

  it("keeps the spelling of a plain scalar the parser would resolve", () => {
    // The parser resolves a plain number to a JavaScript number, and
    // `3.10` resolves to `3.1`. The text is what a version is written as.
    const document = readYamlDocument(["a: 3.10", "b: 2024.10", "c: v2.0.0"].join("\n"));
    expect(scalarText(findEntry(document.root, "a")?.value)).toBe("3.10");
    expect(scalarText(findEntry(document.root, "b")?.value)).toBe("2024.10");
    expect(scalarText(findEntry(document.root, "c")?.value)).toBe("v2.0.0");
  });

  it.each([
    ["double quotes", "a", 'a: "3.10"'],
    ["single quotes", "b", "b: '3.10'"],
  ])("reads a quoted number as the parser resolved it, in %s", (_name, key, value) => {
    const document = readYamlDocument(value);
    expect(scalarText(findEntry(document.root, key)?.value)).toBe("3.10");
  });

  it("reads an empty document", () => {
    const document = readYamlDocument("");
    expect(document.root).toBeUndefined();
    expect(document.uncertain).toBe(false);
  });
});
