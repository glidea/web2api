import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const profileDirectory: string = process.env["WEB2API_GROK_PROFILE"] ?? join(homedir(), ".web2api", "grok-profile");
const defaultExecutablePath: string | undefined = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined;
const executablePath: string | undefined = process.env["WEB2API_GROK_EXECUTABLE"] ?? defaultExecutablePath;

if (executablePath === undefined) {
  throw new Error("WEB2API_GROK_EXECUTABLE is required outside macOS");
}

await mkdir(profileDirectory, { recursive: true });

const chrome: ChildProcess = spawn(executablePath, [
  `--user-data-dir=${profileDirectory}`,
  "--no-first-run",
  "--no-default-browser-check",
  "https://grok.com/"
], {
  detached: true,
  stdio: "ignore"
});
chrome.unref();
process.stdout.write(`Grok profile opened in Google Chrome: ${profileDirectory}\n`);
