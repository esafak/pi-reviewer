import type { LogRecord } from "./types.js";

export type LogTarget = "local" | "github";
export type LogStream = "stdout" | "stderr";

export interface FormatOptions {
  target?: LogTarget;
  color?: boolean;
  prefix?: string;
  annotations?: Readonly<Record<string, "warning" | "error">>;
}

export interface FormattedLog {
  stream: LogStream;
  text: string;
}

const ANSI: Record<LogRecord["level"], string> = {
  debug: "\u001b[90m",
  info: "\u001b[36m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};
const FIELD_KEY_COLOR = "\u001b[94m";
const FIELD_VALUE_COLOR = "\u001b[32m";
const JSON_KEY_COLOR = "\u001b[95m";
const JSON_STRING_COLOR = "\u001b[32m";
const JSON_NUMBER_COLOR = "\u001b[33m";
const JSON_LITERAL_COLOR = "\u001b[35m";
const ANSI_RESET = "\u001b[0m";
const LEVEL_LABEL: Record<LogRecord["level"], string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function colorJson(value: string): string {
  try {
    JSON.parse(value);
  } catch {
    return value;
  }
  return value.replace(
    /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g,
    (
      token,
      key: string | undefined,
      stringValue: string | undefined,
      number: string | undefined,
    ) => {
      if (key) return `"${JSON_KEY_COLOR}${key.slice(1, -1)}${ANSI_RESET}"`;
      if (stringValue) return `"${JSON_STRING_COLOR}${stringValue.slice(1, -1)}${ANSI_RESET}"`;
      if (number) return `${JSON_NUMBER_COLOR}${number}${ANSI_RESET}`;
      return `${JSON_LITERAL_COLOR}${token}${ANSI_RESET}`;
    },
  );
}

function formatField(key: string, value: unknown, color: boolean): string {
  const printableValue = printable(value);
  if (!color) return `${key}=${printableValue}`;
  const renderedValue = colorJson(printableValue);
  return `${FIELD_KEY_COLOR}${key}${ANSI_RESET}=${FIELD_VALUE_COLOR}${renderedValue}${ANSI_RESET}`;
}

export function escapeWorkflowCommand(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function formatLog(record: LogRecord, options: FormatOptions = {}): FormattedLog {
  const prefix = options.prefix ? `[${options.prefix}] ` : "";
  const annotation = options.target === "github" ? options.annotations?.[record.event] : undefined;
  const githubAnnotation = annotation !== undefined;
  const useColor = options.color === true && !githubAnnotation;
  const fields = Object.entries(record.fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => formatField(key, value, useColor))
    .join(" ");
  const suffix = fields ? ` ${fields}` : "";
  const levelPrefix = options.target === "github" ? `${LEVEL_LABEL[record.level]} ` : "";
  const content = `${prefix}${levelPrefix}${record.message}${suffix}`;
  if (record.kind === "group") {
    const lines =
      options.target === "github"
        ? formatGroup(record.message, String(record.fields.content ?? ""))
        : [`${record.message}:`, String(record.fields.content ?? "")];
    return { stream: record.level === "warn" ? "stderr" : "stdout", text: lines.join("\n") };
  }
  const renderedContent = githubAnnotation ? escapeWorkflowCommand(content) : content;
  const colorized = useColor
    ? `${ANSI[record.level]}${renderedContent}${ANSI_RESET}`
    : renderedContent;
  const text = githubAnnotation ? `::${annotation}::${colorized}` : colorized;
  return {
    stream: record.level === "warn" || record.level === "error" ? "stderr" : "stdout",
    text,
  };
}

export function formatGroup(label: string, content: string): readonly string[] {
  return [
    `::group::${label}`,
    ...content.split(/\r?\n/).map((line) => `| ${line}`),
    "::endgroup::",
  ];
}
