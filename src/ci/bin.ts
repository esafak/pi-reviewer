#!/usr/bin/env tsx
import { init } from "./init.js";
import { log } from "./log.js";

const command = process.argv[2];

if (command === "init") {
  await init();
} else {
  log.error("cli.command.unknown", "Unknown command", { command: command ?? "(none)" });
  log.error("cli.usage", "Usage: pi-reviewer init");
  process.exit(1);
}
