import { Scalar, isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";

/**
 * A YAML reader for the constructs a workflow or a tool configuration uses.
 *
 * The reader is a bounded adapter over a YAML parser. It reads the
 * document's structure, and it reports the constructs it does not interpret
 * — an anchor, an alias, a tag, a flow collection — as coverage: the
 * construct is read, and what is inside it is not. A document the parser
 * could not read yields nothing at all, because a dependency that was never
 * read must never become an upgrade that did not happen.
 *
 * A comment is kept with the value it trails, because a pinned action's
 * version lives in the comment beside its digest rather than in the
 * reference itself.
 */

/** A node in a YAML document. */
export type YamlNode = YamlScalar | YamlMapping | YamlSequence;

/** A scalar value. */
export interface YamlScalar {
  kind: "scalar";
  /** The value's text, with the quotes removed. */
  value: string;
  /** The comment that trails the value on its line. */
  comment?: string;
  /** The 1-based line the value is on. */
  line: number;
  /** The value was quoted, so its text is literal. */
  quoted: boolean;
  /**
   * The value was not read: it is an anchor, an alias, a tag, or a flow
   * collection, and the reader does not interpret what is inside it. A
   * caller that must know whether a value was read looks here, because an
   * unread value is not the same as an empty one.
   */
  unread?: boolean;
}

/** One entry of a mapping. */
export interface YamlMappingEntry {
  /** The key, with the quotes removed. */
  key: string;
  /** The value. */
  value: YamlNode;
  /** The 1-based line the entry is on. */
  line: number;
}

/** A mapping of keys to values. */
export interface YamlMapping {
  kind: "mapping";
  entries: YamlMappingEntry[];
  /** The 1-based line the mapping starts on. */
  line: number;
}

/** A sequence of values. */
export interface YamlSequence {
  kind: "sequence";
  items: YamlNode[];
  /** The 1-based line the sequence starts on. */
  line: number;
}

/** The result of reading a document. */
export interface YamlDocument {
  /** The document's root, when it has one. */
  root?: YamlNode;
  /** Constructs the reader read but does not interpret. */
  warnings: string[];
  /**
   * Syntax the reader could not read. A syntax error means the reader no
   * longer knows where it is, so nothing the document contains can be
   * trusted.
   */
  errors: string[];
  /** The reader lost its place, so nothing the document contains can be trusted. */
  uncertain: boolean;
}

/**
 * The deepest a document may nest.
 *
 * The reader is recursive, so a document that nests without bound would
 * exhaust the stack rather than report a coverage gap. The limit is well
 * beyond any manifest a build writes.
 */
const MAX_DEPTH = 64;

/** The line a source offset is on. */
class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") this.starts.push(index + 1);
    }
  }

  /** The 1-based line an offset is on. */
  line(offset: number | undefined): number {
    if (offset === undefined) return 0;
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((this.starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }
}

/** The offset a node starts at. */
function nodeOffset(node: unknown): number | undefined {
  if (!isNode(node)) return undefined;
  return node.range?.[0];
}

/**
 * The anchor a node carries, when it has one.
 *
 * A node that names an anchor names a node the reader does not interpret.
 */
function nodeAnchor(node: Node): string | undefined {
  if (isScalar(node)) return node.anchor;
  if (isMap(node) || isSeq(node)) return node.anchor;
  return undefined;
}

/**
 * The text of a scalar, as it was written.
 *
 * A plain scalar is a number or a boolean as far as the parser is
 * concerned, and the value it resolves to has lost its spelling: `3.10`
 * resolves to `3.1`, and a version written that way would be compared as
 * the wrong version. The plain scalar's own text is therefore kept, and
 * only the quoted and the block scalars are read as the parser resolved
 * them.
 */
function scalarTextOf(node: Scalar): string {
  if (node.type === Scalar.PLAIN && node.source !== undefined) return node.source;
  if (node.value === null) return "";
  return String(node.value);
}

/**
 * Whether a value is a YAML node.
 *
 * The parser's own types are not precise about what a mapping holds, so the
 * value is narrowed rather than taken on trust.
 */
function isNode(value: unknown): value is Node {
  return isAlias(value) || isMap(value) || isScalar(value) || isSeq(value);
}

/** The reader's diagnostics. */
export interface YamlDiagnostics {
  /** Constructs the reader read but does not interpret. */
  warnings: string[];
  /** Syntax the reader could not read. */
  errors: string[];
}

/** The reader's own view of a parsed document. */
class Converter {
  private readonly warnings: string[] = [];
  private readonly errors: string[] = [];

  constructor(private readonly lines: LineIndex) {}

  /** Reads a node and the nodes inside it. */
  convert(node: unknown, depth: number): YamlNode | undefined {
    if (node === null || node === undefined) return undefined;
    const line = this.lines.line(isNode(node) ? nodeOffset(node) : undefined);
    if (depth > MAX_DEPTH) {
      this.errors.push(`the content on line ${line} is nested too deeply`);
      return undefined;
    }
    if (!isNode(node)) {
      this.warnings.push(`the value on line ${line} is not read`);
      return { kind: "scalar", value: "", line, quoted: false, unread: true };
    }
    // An alias names a node the reader does not resolve, an anchor names a
    // node the reader does not interpret, and a tag says how to read a
    // value the reader does not. A flow collection is read as a value, not
    // as the structure inside it.
    if (isAlias(node)) {
      this.warnings.push(`the alias on line ${line} is not read`);
      return { kind: "scalar", value: "", line, quoted: false, unread: true };
    }
    if (nodeAnchor(node)) {
      this.warnings.push(`the anchor on line ${line} is not read`);
      return { kind: "scalar", value: "", line, quoted: false, unread: true };
    }
    if (node.tag) {
      this.warnings.push(`the tag on line ${line} is not read`);
      return { kind: "scalar", value: "", line, quoted: false, unread: true };
    }
    if (isMap(node)) {
      if (node.flow) {
        this.warnings.push(`the flow value on line ${line} is not read`);
        return { kind: "scalar", value: "", line, quoted: false, unread: true };
      }
      const entries: YamlMappingEntry[] = [];
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
        if (key === undefined) {
          // A key the reader did not interpret leaves the mapping's shape
          // uncertain: the mapping may hold a field the reader does not
          // know about, so the whole mapping is not read.
          this.warnings.push(
            `the key on line ${this.lines.line(nodeOffset(pair.key))} is not read`,
          );
          return { kind: "scalar", value: "", line, quoted: false, unread: true };
        }
        const value = this.convert(pair.value, depth + 1) ?? {
          kind: "scalar" as const,
          value: "",
          line,
          quoted: false,
        };
        entries.push({ key, value, line: this.lines.line(nodeOffset(pair.key)) });
      }
      return { kind: "mapping", entries, line };
    }
    if (isSeq(node)) {
      if (node.flow) {
        this.warnings.push(`the flow value on line ${line} is not read`);
        return { kind: "scalar", value: "", line, quoted: false, unread: true };
      }
      const items = node.items.map((item) => this.convert(item, depth + 1)).filter(isPresent);
      return { kind: "sequence", items, line };
    }
    const comment = node.comment?.trim();
    return {
      kind: "scalar",
      value: scalarTextOf(node),
      ...(comment ? { comment } : {}),
      line,
      quoted: node.type === Scalar.QUOTE_SINGLE || node.type === Scalar.QUOTE_DOUBLE,
    };
  }

  /** The reader's diagnostics. */
  get diagnostics(): YamlDiagnostics {
    return { warnings: this.warnings, errors: this.errors };
  }
}

/** Whether a node is present. */
function isPresent(node: YamlNode | undefined): node is YamlNode {
  return node !== undefined;
}

/**
 * Reads a YAML document.
 *
 * A document that holds syntax the reader could not read is `uncertain`,
 * and an uncertain document is not to be trusted: the caller reports the
 * coverage gap rather than act on a value it did not read.
 */
export function readYamlDocument(text: string): YamlDocument {
  const document = parseDocument(text);
  const errors = document.errors.map((error) => error.message.split("\n")[0] ?? error.message);
  const lines = new LineIndex(text);
  const converter = new Converter(lines);
  const root = converter.convert(document.contents, 0);
  const diagnostics = converter.diagnostics;
  return {
    ...(root ? { root } : {}),
    warnings: [...diagnostics.warnings, ...document.warnings.map((warning) => warning.message)],
    errors: [...diagnostics.errors, ...errors],
    uncertain: errors.length > 0 || diagnostics.errors.length > 0,
  };
}

/** The text of a scalar, when the node is one. */
export function scalarText(node: YamlNode | undefined): string | undefined {
  if (!node || node.kind !== "scalar") return undefined;
  return node.value;
}

/** The entries of a mapping, when the node is one. */
export function mappingEntries(node: YamlNode | undefined): readonly YamlMappingEntry[] {
  if (!node || node.kind !== "mapping") return [];
  return node.entries;
}

/** The entry with the given key, when the node is a mapping that has one. */
export function findEntry(node: YamlNode | undefined, key: string): YamlMappingEntry | undefined {
  return mappingEntries(node).find((entry) => entry.key === key);
}

/**
 * Every entry with the given key, at any depth.
 *
 * A workflow nests its steps under jobs, and a job's steps are a sequence of
 * mappings, so the key a caller wants is not at a known place in the tree.
 */
export function collectEntries(
  node: YamlNode | undefined,
  key: string,
): readonly YamlMappingEntry[] {
  const found: YamlMappingEntry[] = [];
  const walk = (current: YamlNode | undefined): void => {
    if (!current) return;
    if (current.kind === "mapping") {
      for (const entry of current.entries) {
        if (entry.key === key) found.push(entry);
        walk(entry.value);
      }
      return;
    }
    if (current.kind === "sequence") {
      for (const item of current.items) walk(item);
    }
  };
  walk(node);
  return found;
}
