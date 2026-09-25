export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly level: LogLevel;
  readonly event: string;
  readonly message: string;
  readonly fields: LogFields;
  readonly kind?: "group";
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface Logger {
  debug(event: string, message: string, fields?: LogFields): void;
  info(event: string, message: string, fields?: LogFields): void;
  warn(event: string, message: string, fields?: LogFields): void;
  error(event: string, message: string, fields?: LogFields): void;
  group(event: string, label: string, content: string): void;
}
