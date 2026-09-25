import type { LogFields, LogLevel, LogRecord, LogSink, Logger } from "./types.js";
import { formatLog, type FormatOptions } from "./formatter.js";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface CreateLoggerOptions {
  sink?: LogSink;
  minimumLevel?: LogLevel;
  bindings?: LogFields;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const sink = options.sink ?? consoleSink();
  const minimumLevel = LEVEL_ORDER[options.minimumLevel ?? "debug"];
  const bindings = options.bindings ?? {};
  const write = (level: LogLevel, event: string, message: string, fields: LogFields = {}) => {
    if (LEVEL_ORDER[level] < minimumLevel) return;
    sink.write({ level, event, message, fields: { ...bindings, ...fields } });
  };
  return {
    debug: (event, message, fields) => write("debug", event, message, fields),
    info: (event, message, fields) => write("info", event, message, fields),
    warn: (event, message, fields) => write("warn", event, message, fields),
    error: (event, message, fields) => write("error", event, message, fields),
    group: (event, label, content) => {
      if (LEVEL_ORDER.info < minimumLevel) return;
      sink.write({ level: "info", event, message: label, fields: { content }, kind: "group" });
    },
  };
}

export function consoleSink(formatOptions: FormatOptions = {}): LogSink {
  return {
    write(record) {
      const formatted = formatLog(record, formatOptions);
      if (formatted.stream === "stdout") console.log(formatted.text);
      else if (record.level === "warn") console.warn(formatted.text);
      else console.error(formatted.text);
    },
  };
}

export function createMemorySink(): { sink: LogSink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: { write: (record) => records.push(record) }, records };
}
