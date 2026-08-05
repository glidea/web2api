#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsxPackage = dirname(require.resolve("tsx/package.json"));
const tsxCli = join(tsxPackage, "dist/cli.mjs");
const daemonCli = fileURLToPath(new URL("../src/daemon/cli.ts", import.meta.url));
const child = spawn(process.execPath, [tsxCli, daemonCli, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exitCode = code ?? 1;
});
