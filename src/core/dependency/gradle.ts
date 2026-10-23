import { decodeEscapes } from "./escapes.js";

/**
 * A dependency a Gradle build declares.
 */
export interface GradleDependency {
  /** The Maven coordinate, `group:artifact`. */
  readonly coordinate: string;
  /** The version the declaration carries, as written. */
  readonly version?: string;
}

/** What a Gradle build declares, and what the reader could not read. */
export interface GradleReadResult {
  /** The dependencies the build declares. */
  readonly dependencies: readonly GradleDependency[];
  /** The declarations the reader did not read. */
  readonly warnings: string[];
}

/** A block the reader is inside. */
interface GradleBlock {
  /** What the block is. */
  readonly kind: "dependencies" | "control" | "closure";
  /** The word that opened the block. */
  readonly name: string;
}

/** A block the scanner has open. */
interface GradleOpenBlock {
  /** The index of the statement that opened the block. */
  readonly headerIndex: number;
  /** The statements the block holds. */
  readonly statements: number[];
}

/** A statement, and the blocks it sits in. */
interface GradleStatement {
  /** The statement's code. */
  readonly text: string;
  /**
   * The statement's code with the strings masked.
   *
   * A word inside a string is a character of the string, and it is not a
   * word of the code.
   */
  readonly code: string;
  /** The blocks the statement sits in, outermost first. */
  readonly blocks: readonly GradleBlock[];
  /** The statement opens a block, and it is not a declaration. */
  readonly header: boolean;
  /** The statement opens a block that sets the version. */
  readonly closureVersion?: boolean;
}

/** What a scan of a build file found. */
interface GradleScanResult {
  /** The statements the file declares. */
  readonly statements: readonly GradleStatement[];
  /** The file could not be read to its end. */
  readonly error?: string;
}

/** An assignment, as a declaration spells it. */
interface GradleAssignment {
  /** The name of the assigned part. */
  readonly key: string;
  /** The value, as it was written. */
  readonly value: string;
}

/** A coordinate, and the version it carries. */
interface GradleCoordinate {
  /** The group the coordinate names. */
  readonly group: string;
  /** The artifact the coordinate names. */
  readonly artifact: string;
  /** The coordinate, `group:artifact`. */
  readonly coordinate: string;
  /** The version the coordinate carries, when it carries one. */
  readonly version?: string;
  /** The coordinate carries a part the reader does not read. */
  readonly extra: boolean;
}

/** A delimiter that is open. */
type GradleDelimiter = "(" | "[" | "{";

/** A delimiter that closes another. */
type GradleCloser = ")" | "]" | "}";

/** A string literal's extent. */
interface GradleLiteral {
  /** The text between the quotes. */
  readonly value: string;
}

/**
 * The configurations a Gradle build declares its dependencies in.
 *
 * A call in a `dependencies` block is a declaration only when it names a
 * configuration: `println("g:a:1")` prints a message and declares
 * nothing, and the reader must not turn it into a dependency. A
 * configuration the build declares itself is read from the file.
 */
const STANDARD_CONFIGURATIONS: ReadonlySet<string> = new Set([
  "api",
  "compileOnly",
  "compileOnlyApi",
  "implementation",
  "runtimeOnly",
  "runtimeOnlyApi",
  "testAnnotationProcessor",
  "testCompileOnly",
  "testCompileOnlyApi",
  "testImplementation",
  "testRuntimeOnly",
  "testRuntimeOnlyApi",
  "annotationProcessor",
  "developmentOnly",
  "kapt",
  "kaptTest",
  "testFixturesApi",
  "testFixturesCompileOnly",
  "testFixturesImplementation",
  "testFixturesRuntimeOnly",
  "compile",
  "runtime",
  "testCompile",
  "testRuntime",
  "default",
  "coreLibraryDesugaring",
  "androidTestUtil",
  "ksp",
  "kspTest",
  "kspAndroidTest",
  "lintChecks",
  "lintPublish",
  "lintPublishJars",
]);

/**
 * The characters a statement may end with and still continue.
 *
 * A statement that ends with one of them is not finished: the next line
 * continues it.
 */
const CONTINUATION_CHARS = ",+-*/=";

/**
 * The nesting the scanner follows.
 *
 * A file nested deeper than this is not one the reader can walk, and it
 * is reported rather than read. The bound also keeps the reader's work
 * linear in the file's length: a block that holds every block would make
 * the reader copy a stack that grows with the file.
 */
const MAX_NESTING = 64;

/** The keywords that open a block of control flow. */
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "unless",
  "while",
  "for",
  "switch",
  "try",
  "catch",
  "finally",
  "do",
  "else",
  "when",
]);

/**
 * The words a slashy string may follow.
 *
 * A slashy string is a string, and a string may hold a declaration that
 * means nothing.
 */
const SLASHY_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "when",
  "if",
  "unless",
  "while",
  "assert",
  "in",
  "and",
  "or",
  "not",
  "then",
  "else",
  "case",
  "new",
  "yield",
  "do",
]);

/**
 * The kind of block a header opens.
 *
 * A `dependencies` block holds declarations, a block of control flow
 * holds them too, and a closure configures a declaration and holds
 * nothing.
 */
function blockKind(header: string): GradleBlock {
  const first = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(header)?.[1] ?? "";
  // A block may be named by a qualified name: the Kotlin script writes
  // `commonMain.dependencies`, and the block holds dependencies. The name
  // is read backwards, so a long header costs the reader nothing.
  const qualified = trailingQualifiedName(header);
  const last = qualified.split(".").at(-1) ?? "";
  if (last === "dependencies") return { kind: "dependencies", name: last };
  if (CONTROL_KEYWORDS.has(first)) return { kind: "control", name: first };
  return { kind: "closure", name: last || first };
}

/**
 * The qualified name a header ends with.
 *
 * The name is read backwards, from the end of the header, so that a header
 * the reader does not understand costs it the length of its last word and
 * not the length of the header.
 */
function trailingQualifiedName(header: string): string {
  const text = header.trimEnd();
  const words: string[] = [];
  let end = text.length;
  for (;;) {
    let start = end;
    while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1]!)) start -= 1;
    if (start === end) break;
    words.push(text.slice(start, end));
    if (start > 0 && text[start - 1] === ".") {
      end = start - 1;
      continue;
    }
    break;
  }
  return words.reverse().join(".");
}

/**
 * Whether a slash at this point opens a slashy string.
 *
 * A slash between two values is a division, and a slash where a value is
 * expected is a string. The context comes from the state the scanner
 * keeps, because a scan of the statement's prefix would make a file with
 * many divisions cost the runner the square of its length.
 */
function slashyStart(context: GradleContext): boolean {
  if (!context.lastChar) return true;
  // An operator is followed by an operand, and an operand may be a
  // string.
  if ("=([{,:~+-*/%&|^?<>!.".includes(context.lastChar)) return true;
  return SLASHY_KEYWORDS.has(context.lastWord);
}

/** What the scanner knows about the text it has read. */
interface GradleContext {
  /** The last character that is not a space. */
  readonly lastChar: string;
  /** The last word the scanner read. */
  readonly lastWord: string;
}

/**
 * Scans a build file into the statements it declares.
 *
 * The scanner reads the file the way the build reads it: a brace opens a
 * block, a newline or a semicolon ends a statement, and a string or a
 * comment is never markup. A statement that continues on the next line —
 * a declaration whose arguments are spread over several lines — is joined
 * into one.
 *
 * A file the scanner could not read to its end yields no statements at
 * all: a document the reader lost its place in must not become a document
 * that declares what it does not.
 */
function scanStatements(text: string, kotlin: boolean): GradleScanResult {
  const statements: GradleStatement[] = [];
  const blocks: GradleBlock[] = [];
  /** The blocks the scanner has open, and the statements they hold. */
  const open: GradleOpenBlock[] = [];
  /** The headers whose block sets a version. */
  const setsVersion = new Set<number>();
  const delimiters: GradleDelimiter[] = [];
  let current = "";
  let code = "";
  let lastChar = "";
  let lastWord = "";
  let quote: string | undefined;
  let commentDepth = 0;
  let inLineComment = false;
  let inSlashy = false;
  let dollarSlashy = false;

  // The context is the text the scanner has read, and it is kept as the
  // scanner goes: a file may hold many slashes, and a scan of the
  // statement's prefix for each of them would grow with the square of the
  // file.
  const read = (char: string): void => {
    if (/\s/.test(char)) return;
    lastChar = char;
    if (/[A-Za-z0-9_]/.test(char)) lastWord += char;
    else lastWord = "";
  };
  const emit = (header = false): void => {
    const trimmed = current.trim();
    if (trimmed.length) {
      statements.push({ text: trimmed, code: code.trim(), blocks: [...blocks], header });
      open.at(-1)?.statements.push(statements.length - 1);
    }
    current = "";
    code = "";
    lastChar = "";
    lastWord = "";
  };
  // A statement that ends with a comma or an operator continues on the
  // next line, and one whose parentheses are open does too. The trailing
  // character comes from the state the scanner keeps, so a statement that
  // grows does not cost the reader its time.
  const endLine = (): void => {
    if (delimiters.length === 0 && !CONTINUATION_CHARS.includes(lastChar)) emit();
  };
  // A closer must match the delimiter it closes, or the reader no longer
  // knows where the statement ends.
  const closes = (closer: GradleCloser): boolean => {
    const open = delimiters.pop();
    if (open === undefined) return false;
    const openers: Readonly<Record<GradleCloser, GradleDelimiter>> = {
      ")": "(",
      "]": "[",
      "}": "{",
    };
    return openers[closer] === open;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inSlashy) {
      // A slashy string holds text, and the text is not code.
      if (!dollarSlashy && char === "\\") {
        index += 1;
        continue;
      }
      if (char === "$" && text[index + 1] === "{") {
        return { statements: [], error: "a string with an interpolation is not read" };
      }
      if (dollarSlashy && char === "$" && next === "$") {
        // A dollar-slashy string escapes a dollar with a second one.
        index += 1;
        continue;
      }
      if (dollarSlashy && char === "$" && next === "/") {
        // A dollar-slashy string escapes the pair that opens it.
        index += 1;
        continue;
      }
      if (char === "/" && (!dollarSlashy || next === "$")) {
        inSlashy = false;
        if (dollarSlashy) index += 1;
        // The string's text is not the statement's text, and the
        // statement must not look as if it ends with an operator.
        current += '""';
        read('"');
      }
      continue;
    }
    if (commentDepth > 0) {
      // A block comment may nest, which is what the Kotlin script does.
      if (char === "/" && next === "*") {
        commentDepth += 1;
        index += 1;
        continue;
      }
      if (char === "*" && next === "/") {
        commentDepth -= 1;
        index += 1;
        continue;
      }
      continue;
    }
    if (inLineComment) {
      // The newline that ends the comment ends the statement too.
      if (char === "\n") {
        inLineComment = false;
        endLine();
      }
      continue;
    }
    if (quote) {
      // An escape stands for the character that follows it, and it may
      // stand for a delimiter. A Kotlin raw string processes no escape,
      // and only a raw string is one.
      if (char === "\\" && !(kotlin && quote === '"""')) {
        const escaped = text[index + 1];
        if (escaped === undefined) return { statements: [], error: "a string is never closed" };
        current += char + escaped;
        index += 1;
        continue;
      }
      // An interpolation holds a string of its own, and the reader cannot
      // say where it ends: the text it covers is not code, and the reader
      // does not read it.
      if ((quote === '"' || quote === '"""') && char === "$" && text[index + 1] === "{") {
        return { statements: [], error: "a string with an interpolation is not read" };
      }
      if (quote.length === 3) {
        if (char === quote[0] && next === quote[1] && text[index + 2] === quote[2]) {
          current += quote;
          read('"');
          quote = undefined;
          index += 2;
        }
        continue;
      }
      current += char;
      if (char === quote) {
        read('"');
        quote = undefined;
      }
      continue;
    }
    // The code is the text outside the strings.
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      commentDepth = 1;
      index += 1;
      continue;
    }
    // The dollar-slashy pair opens a string wherever it appears: no
    // expression can begin with it.
    if (char === "$" && next === "/") {
      // A dollar-slashy string holds text, and the text is not code.
      inSlashy = true;
      dollarSlashy = true;
      index += 1;
      continue;
    }
    if (char === "/" && slashyStart({ lastChar, lastWord })) {
      // A slashy string holds text, and the text is not code.
      inSlashy = true;
      dollarSlashy = false;
      continue;
    }
    if (char === '"' || char === "'") {
      const triple = next === char && text[index + 2] === char;
      quote = triple ? char.repeat(3) : char;
      current += quote;
      code += quote;
      read(char);
      index += quote.length - 1;
      continue;
    }
    if (char === "(") {
      delimiters.push("(");
      current += char;
      read(char);
      continue;
    }
    if (char === "[") {
      delimiters.push("[");
      current += char;
      read(char);
      continue;
    }
    if (char === ")") {
      if (!closes(")")) return { statements: [], error: "a parenthesis does not match" };
      current += char;
      read(char);
      continue;
    }
    if (char === "]") {
      if (!closes("]")) return { statements: [], error: "a bracket does not match" };
      current += char;
      read(char);
      continue;
    }
    if (char === "{") {
      if (delimiters.length > 0) {
        // A closure inside a call is part of the call, not a block.
        delimiters.push("{");
        current += char;
        continue;
      }
      // The statement before the brace is either the name of the block or
      // a declaration the block configures. Either way it is a statement,
      // and the block it opens is read on its own terms.
      const block = blockKind(current);
      emit(true);
      const headerIndex = statements.length - 1;
      // The nesting is bounded: a block that holds every block would make
      // the reader's work grow with the square of the file's length.
      if (blocks.length >= MAX_NESTING) {
        return { statements: [], error: "a block is nested too deeply" };
      }
      open.push({ headerIndex, statements: [] });
      blocks.push(block);
      continue;
    }
    if (char === "}") {
      if (delimiters.length > 0) {
        if (!closes("}")) return { statements: [], error: "a brace does not match" };
        current += char;
        read(char);
        continue;
      }
      emit();
      if (!blocks.length) return { statements: [], error: "a closing brace has no block" };
      blocks.pop();
      const closed = open.pop();
      // A closure may set the version the dependency resolves to, and
      // then the version the coordinate carries is not the one the build
      // uses. A statement that assigns the version is what sets it: a
      // string that holds the word is not an assignment.
      const sets = closed?.statements.some((index) =>
        /\bversion\b|\bversionConstraint\b/.test(statements[index]?.code ?? ""),
      );
      if (sets) {
        setsVersion.add(closed!.headerIndex);
        // The version reaches the declaration the closure belongs to,
        // through the blocks in between.
        for (const block of open) setsVersion.add(block.headerIndex);
      }
      continue;
    }
    if (char === ";") {
      emit();
      continue;
    }
    if (char === "\n") {
      endLine();
      continue;
    }
    current += char;
    code += char;
    read(char);
  }
  if (quote) return { statements: [], error: "a string is never closed" };
  if (inSlashy) return { statements: [], error: "a string is never closed" };
  if (commentDepth > 0) return { statements: [], error: "a comment is never closed" };
  if (delimiters.length) return { statements: [], error: "a delimiter is never closed" };
  if (blocks.length) return { statements: [], error: "a block is never closed" };
  emit();
  return {
    statements: statements.map((statement, index) =>
      setsVersion.has(index) ? { ...statement, closureVersion: true } : statement,
    ),
  };
}

/**
 * Whether a statement declares a dependency.
 *
 * A declaration lives in a `dependencies` block, and a block of control
 * flow inside one holds declarations too. A closure configures a
 * declaration and declares nothing.
 */
function declaresDependency(blocks: readonly GradleBlock[]): boolean {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === "closure") return false;
    if (block.kind === "dependencies") return true;
  }
  return false;
}

/**
 * The calls that create a configuration.
 *
 * A call in a `configurations` block that is not one of these declares
 * nothing: `println("hello")` prints a message and creates no
 * configuration, and a configuration that does not exist cannot hold a
 * dependency.
 */
const CONFIGURATION_CALLS: ReadonlySet<string> = new Set(["create", "register", "maybeCreate"]);

/**
 * The endings a plugin's configuration names carry.
 *
 * A plugin adds configurations of its own — an `androidTestImplementation`
 * or a `debugImplementation` — and the reader cannot know the names, but
 * it can know the shape.
 */
const CONFIGURATION_FAMILIES: readonly string[] = ["ksp", "kapt", "androidTest"];

const CONFIGURATION_SUFFIXES: readonly string[] = ["Implementation", "Only", "Api", "Processor"];

/**
 * The configurations the build file declares itself.
 *
 * A build may declare a configuration of its own, and a dependency in it
 * is a dependency of the project. The declaration is a name of its own,
 * a call that creates one, or a delegated property that creates one.
 */
function declaredConfigurations(statements: readonly GradleStatement[]): Set<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    // A delegated property creates a configuration where it stands.
    const delegated = /^\s*val\s+([A-Za-z_][A-Za-z0-9_]*)\s+by\s+.*configurations\.creating/.exec(
      statement.text,
    );
    if (delegated?.[1]) {
      names.add(delegated[1]);
      continue;
    }
    const block = statement.blocks.at(-1);
    const inConfigurations = block?.name === "configurations";
    // A configuration may be created with a call: `create("custom")`, and
    // the call may name the object that holds the configurations. A call
    // on anything else creates no configuration: `tasks.register("x")`
    // registers a task.
    const call = /(?:^|\.)([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*["']([^"']+)["']/.exec(statement.text);
    if (call?.[1] && CONFIGURATION_CALLS.has(call[1])) {
      // The call names the object that holds the configurations, and a
      // call on anything else creates no configuration. An unqualified
      // call creates one only in a configuration scope.
      const receiver = statement.text.slice(0, call.index).trim();
      if (receiver === "configurations" || (!receiver && inConfigurations)) {
        names.add(call[2]!);
      }
      continue;
    }
    if (!inConfigurations) continue;
    const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(statement.text)?.[1];
    if (name) names.add(name);
  }
  return names;
}

/**
 * Whether a name is a configuration.
 *
 * A configuration is one the reader knows, one the build declares, or one
 * whose name carries the shape a plugin gives its own.
 */
function isConfiguration(name: string, declared: ReadonlySet<string>): boolean {
  if (STANDARD_CONFIGURATIONS.has(name)) return true;
  if (declared.has(name)) return true;
  if (CONFIGURATION_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  // A plugin adds a configuration per target: `kspJvm`,
  // `kaptAndroidTest`, and the rest of their families.
  return CONFIGURATION_FAMILIES.some((family) => name.startsWith(family));
}

/**
 * Splits a piece of text at the separators that are not inside a string or
 * a nested pair of brackets.
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      current += char;
      if (char === "\\") {
        const escaped = text[index + 1];
        if (escaped !== undefined) {
          current += escaped;
          index += 1;
        }
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      current += char;
      continue;
    }
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Splits a piece of text at the first separator that is not inside a
 * string or a nested pair of brackets.
 *
 * A Groovy map spells the assignment with a colon and a Kotlin named
 * argument spells it with an equals sign, and the value may hold either
 * character.
 */
function splitAssignment(text: string): GradleAssignment | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && (char === ":" || char === "=")) {
      return { key: text.slice(0, index).trim(), value: text.slice(index + 1).trim() };
    }
  }
  return undefined;
}

/**
 * Whether a piece of text assigns a value at its top level.
 *
 * A Groovy map spells the assignment with a colon and a Kotlin named
 * argument spells it with an equals sign, and a coordinate or a call
 * carries neither at its top level.
 */
function assignsAtTopLevel(text: string): boolean {
  return splitTopLevel(text, ":").length > 1 || splitTopLevel(text, "=").length > 1;
}

/**
 * Reads a string literal, when the text is nothing but one.
 *
 * A literal that is followed by more text is an expression, not a
 * literal: `"1.0" + patch` names a computed version, and reading the
 * literal out of it would name a version the build never pins.
 */
function readLiteral(text: string): GradleLiteral | undefined {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== '"' && first !== "'") return undefined;
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === first) {
      if (index !== trimmed.length - 1) return undefined;
      const value = decodeEscapes(trimmed.slice(1, index), "escaped");
      if (value === undefined) return undefined;
      return { value };
    }
  }
  return undefined;
}

/**
 * Whether a literal interpolates something.
 *
 * A literal that interpolates is not a literal identity: the artifact it
 * names is decided when the build runs, and the manifest does not say
 * which one it is.
 */
function interpolates(literal: GradleLiteral): boolean {
  return /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(literal.value);
}

/** The text a declaration's argument carries. */
function argumentText(statement: string): string | undefined {
  const trimmed = statement.trim();
  if (!trimmed.startsWith("(")) return trimmed;
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        if (trimmed.slice(index + 1).trim().length) return undefined;
        return trimmed.slice(1, index);
      }
    }
  }
  return undefined;
}

/**
 * Reads a coordinate into the artifact it names and the version it
 * carries.
 *
 * A coordinate is `group:artifact:version`, and the version may carry an
 * extension — `group:artifact:1.0@jar` — which names the artifact rather
 * than the version. A coordinate with a part the reader does not read is
 * reported, because the part may name a version.
 */
function readCoordinate(text: string): GradleCoordinate | undefined {
  const parts = text.split(":");
  if (parts.length < 2) return undefined;
  const group = parts[0]?.trim();
  const artifact = parts[1]?.trim();
  if (!group || !artifact) return undefined;
  const raw = parts[2];
  if (raw === undefined)
    return { group, artifact, coordinate: `${group}:${artifact}`, extra: false };
  const at = raw.indexOf("@");
  const version = (at === -1 ? raw : raw.slice(0, at)).trim();
  return {
    group,
    artifact,
    coordinate: `${group}:${artifact}`,
    ...(version.length ? { version } : {}),
    extra: parts.length > 3,
  };
}

/** A declaration's parts, before they are read as a dependency. */
interface GradleDeclaration {
  /** The coordinate the declaration names. */
  readonly coordinate?: string;
  /** The version the declaration carries, as written. */
  readonly version?: string;
  /** The declaration names a version the reader does not read. */
  readonly unreadVersion?: boolean;
  /** The declaration is not a dependency the reader reads. */
  readonly unread?: boolean;
}

/**
 * Reads a declaration into the coordinate and the version it names.
 *
 * A declaration is written in three spellings: a coordinate string, a
 * Groovy map, and a Kotlin call with named arguments. The last two name
 * the group's parts separately, and the coordinate is built from them.
 *
 * A coordinate is a literal: a declaration whose coordinate is computed
 * names no artifact, and the reader does not read it. A version may be
 * computed, and then it is kept as it was written, because the comparison
 * cannot read it and the report names the expression that changed.
 */
function readDeclaration(text: string): GradleDeclaration {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return { unread: true };
  const rest = match[2] ?? "";
  if (!rest.trim().length) return { unread: true };
  const argument = argumentText(rest);
  if (argument === undefined) return { unread: true };
  return readArgument(argument);
}

/**
 * Reads an argument into the coordinate and the version it names.
 *
 * A declaration is written in three spellings: a coordinate string, a
 * Groovy map, and a Kotlin call with named arguments. The last two name
 * the group's parts separately, and the coordinate is built from them.
 *
 * A coordinate is a literal: a declaration whose coordinate is computed
 * names no artifact, and the reader does not read it. A version may be
 * computed, and then it is kept as it was written, because the comparison
 * cannot read it and the report names the expression that changed.
 */
function readArgument(argument: string): GradleDeclaration {
  const trimmed = argument.trim();
  if (!trimmed.length) return { unread: true };
  // A coordinate string.
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const literal = readLiteral(trimmed);
    if (literal === undefined) return { unread: true };
    const read = readCoordinate(literal.value);
    if (!read) return { unread: true };
    // A coordinate whose group or artifact interpolates names no artifact:
    // the build decides which one it is, and the manifest does not say.
    if (interpolates({ value: read.group }) || interpolates({ value: read.artifact })) {
      return { unread: true };
    }
    return {
      coordinate: read.coordinate,
      ...(read.version ? { version: read.version } : {}),
      unreadVersion: read.extra,
    };
  }
  // A map of the declaration's parts.
  if (assignsAtTopLevel(trimmed)) {
    const parts = new Map<string, string>();
    for (const item of splitTopLevel(trimmed, ",")) {
      const entry = item.trim();
      if (!entry.length) continue;
      const assignment = splitAssignment(entry);
      if (!assignment || !assignment.key.length) continue;
      parts.set(assignment.key, assignment.value);
    }
    const group =
      parts.get("group") === undefined ? undefined : readLiteral(parts.get("group") as string);
    const name =
      parts.get("name") === undefined ? undefined : readLiteral(parts.get("name") as string);
    if (!group || !name) return { unread: true };
    if (interpolates(group) || interpolates(name)) return { unread: true };
    const rawVersion = parts.get("version");
    // A version that is not a literal is an expression, and it is kept as
    // it was written: the comparison cannot read it, and the report names
    // the expression.
    const version =
      rawVersion === undefined ? undefined : (readLiteral(rawVersion)?.value ?? rawVersion);
    return {
      coordinate: `${group.value}:${name.value}`,
      ...(version ? { version } : {}),
    };
  }
  // A call the reader does not read: a project, a file, a platform.
  return { unread: true };
}

/**
 * Reads the dependencies a Gradle build declares.
 *
 * The declarations are the ones in a `dependencies` block, and they name
 * a configuration and a Maven coordinate. A build script declares its
 * build-time classpath in a `buildscript` block, which is a different
 * block, and a plugin's version in a `plugins` block, which is neither:
 * both are reported rather than read.
 */
export function readGradleDependencies(text: string, kotlin = false): GradleReadResult {
  const scan = scanStatements(text, kotlin);
  if (scan.error) {
    return { dependencies: [], warnings: [`build.gradle could not be read: ${scan.error}`] };
  }
  const dependencies: GradleDependency[] = [];
  const warnings: string[] = [];
  const reported = new Set<string>();
  const report = (message: string): void => {
    if (reported.has(message)) return;
    reported.add(message);
    warnings.push(message);
  };
  const configurations = declaredConfigurations(scan.statements);
  for (const statement of scan.statements) {
    if (statement.blocks.some((block) => block.name === "plugins")) {
      report("build.gradle declares plugins, which are not read");
      continue;
    }
    if (!declaresDependency(statement.blocks)) continue;
    if (statement.blocks.some((block) => block.name === "buildscript")) {
      report("build.gradle declares a buildscript classpath, which is not read");
      continue;
    }
    // The Kotlin script names the configuration with a literal.
    const literal = /^\s*["']([^"']+)["']\s*\(/.exec(statement.text);
    if (literal?.[1]) {
      if (statement.closureVersion) {
        report("a dependency declaration sets its version in a closure, which is not read");
        continue;
      }
      if (!isConfiguration(literal[1], configurations)) {
        report(
          "a statement in the dependencies block names a configuration the reader does not know",
        );
        continue;
      }
      const argument = argumentText(statement.text.slice(literal[0].length - 1));
      if (argument === undefined) {
        report("a dependency declaration is not read");
        continue;
      }
      const declared = readArgument(argument);
      if (declared.unread || !declared.coordinate) {
        report("a dependency declaration is not read");
        continue;
      }
      if (!declared.version) {
        report(`${declared.coordinate} has no version`);
        continue;
      }
      dependencies.push({ coordinate: declared.coordinate, version: declared.version });
      continue;
    }
    const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(statement.text)?.[1];
    // A statement that opens a block of control flow is a header, and it
    // declares nothing. A declaration that a closure configures is a
    // header too, and it declares the dependency.
    if (statement.header && name && CONTROL_KEYWORDS.has(name)) continue;
    // A call that names no configuration is not a declaration: a build
    // script may print a coordinate, and printing one declares nothing.
    if (!name) {
      report(
        "a statement in the dependencies block names a configuration the reader does not know",
      );
      continue;
    }
    if (name === "add") {
      // The dependency handler adds a dependency to a configuration it
      // names: `add("smokeTest", "group:artifact:version")`.
      if (statement.closureVersion) {
        report("a dependency declaration sets its version in a closure, which is not read");
        continue;
      }
      const added = readAddedDependency(statement.text);
      if (added.unread || !added.coordinate) {
        report("a dependency declaration is not read");
        continue;
      }
      if (!added.version) {
        report(`${added.coordinate} has no version`);
        continue;
      }
      dependencies.push({ coordinate: added.coordinate, version: added.version });
      continue;
    }
    if (!isConfiguration(name, configurations)) {
      report(
        "a statement in the dependencies block names a configuration the reader does not know",
      );
      continue;
    }
    if (statement.closureVersion) {
      // The closure sets the version the dependency resolves to, and the
      // version the coordinate carries is not the one.
      report("a dependency declaration sets its version in a closure, which is not read");
      continue;
    }
    const declaration = readDeclaration(statement.text);
    if (declaration.unread) {
      report("a dependency declaration is not read");
      continue;
    }
    if (!declaration.coordinate) {
      report("a dependency declaration names no coordinate");
      continue;
    }
    if (declaration.unreadVersion) {
      report("a dependency coordinate carries parts that are not read");
    }
    if (!declaration.version) {
      report(`${declaration.coordinate} has no version`);
      continue;
    }
    dependencies.push({ coordinate: declaration.coordinate, version: declaration.version });
  }
  return { dependencies, warnings };
}

/**
 * Reads the dependency an `add` call declares.
 *
 * The call names the configuration it adds to and the dependency it adds,
 * and the dependency is a coordinate string.
 */
function readAddedDependency(text: string): GradleDeclaration {
  const argument = argumentText(text.slice("add".length));
  if (argument === undefined) return { unread: true };
  const parts = splitTopLevel(argument, ",").map((part) => part.trim());
  const dependency = parts[1];
  if (dependency === undefined) return { unread: true };
  const literal = readLiteral(dependency);
  if (!literal) return { unread: true };
  const read = readCoordinate(literal.value);
  if (!read) return { unread: true };
  if (interpolates({ value: read.group }) || interpolates({ value: read.artifact })) {
    return { unread: true };
  }
  return {
    coordinate: read.coordinate,
    ...(read.version ? { version: read.version } : {}),
    unreadVersion: read.extra,
  };
}
