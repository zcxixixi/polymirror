#!/usr/bin/env node
import "dotenv/config";
import { startBot } from "./engine/copy-cycle.js";

startBot(process.env.CONFIG_PATH ?? "config.yaml").catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
