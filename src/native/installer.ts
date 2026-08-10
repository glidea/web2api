import { access, chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { defaultDataDirectory } from "../daemon/config";

const hostName: string = "dev.glidea.web2api";
const execFileAsync: (file: string, args: readonly string[]) => Promise<unknown> = promisify(execFile);

export type NativeInstallOptions = {
  platform: NodeJS.Platform;
  extensionId: string;
  dataDirectory: string;
  manifestDirectory: string;
  runtimeSource: string;
  nodePath: string;
};

export type NativeInstallResult = {
  hostPath: string;
  manifestPath: string;
  runtimePath: string;
};

export type NativeInstallInspection = ({ installed: true } & NativeInstallResult) | { installed: false };

type NativeHostManifest = {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
};

export async function installBundledExtension(runtimeSource: string, dataDirectory: string): Promise<string> {
  const sourceDirectory: string = join(dirname(runtimeSource), "extension");
  const targetDirectory: string = join(dataDirectory, "extension");
  await rm(targetDirectory, { recursive: true, force: true });
  await cp(sourceDirectory, targetDirectory, { recursive: true });
  return targetDirectory;
}

export function defaultNativeInstallOptions(extensionId: string, runtimeSource: string): NativeInstallOptions {
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error("extension ID must contain 32 lowercase characters from a to p");
  }
  const dataDirectory: string = defaultDataDirectory();
  const manifestOverride: string | undefined = process.env["WEB2API_NATIVE_MANIFEST_DIR"];
  let manifestDirectory: string;
  if (manifestOverride !== undefined) {
    manifestDirectory = manifestOverride;
  } else {
    switch (process.platform) {
      case "darwin":
        manifestDirectory = join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
        break;
      case "linux":
        manifestDirectory = join(homedir(), ".config", "google-chrome", "NativeMessagingHosts");
        break;
      case "win32":
        manifestDirectory = join(dataDirectory, "native");
        break;
      default:
        throw new Error(`unsupported platform: ${process.platform}`);
    }
  }
  return {
    platform: process.platform,
    extensionId,
    dataDirectory,
    manifestDirectory,
    runtimeSource,
    nodePath: process.execPath
  };
}

export async function installNativeHost(options: NativeInstallOptions): Promise<NativeInstallResult> {
  const paths: NativeInstallResult = resolveInstallPaths(options);
  await mkdir(join(options.dataDirectory, "runtime"), { recursive: true });
  await mkdir(join(options.dataDirectory, "bin"), { recursive: true });
  await mkdir(options.manifestDirectory, { recursive: true });
  await copyFile(options.runtimeSource, paths.runtimePath);
  await writeFile(paths.hostPath, nativeHostWrapper(options.platform, options.nodePath, paths.runtimePath), { mode: 0o755 });
  await chmod(paths.hostPath, 0o755);
  const manifest: NativeHostManifest = {
    name: hostName,
    description: "Glidea Web2API native host",
    path: paths.hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${options.extensionId}/`]
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (options.platform === "win32") {
    const key: string = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
    await execFileAsync("reg.exe", ["ADD", key, "/ve", "/t", "REG_SZ", "/d", paths.manifestPath, "/f"]);
  }
  return paths;
}

export async function inspectNativeHost(options: NativeInstallOptions): Promise<NativeInstallInspection> {
  const paths: NativeInstallResult = resolveInstallPaths(options);
  try {
    await access(paths.hostPath);
    await access(paths.runtimePath);
    const content: string = await readFile(paths.manifestPath, "utf8");
    const manifest: NativeHostManifest = JSON.parse(content) as NativeHostManifest;
    if (manifest.allowed_origins[0] !== `chrome-extension://${options.extensionId}/`) {
      return { installed: false };
    }
    return { installed: true, ...paths };
  } catch {
    return { installed: false };
  }
}

export async function uninstallNativeHost(options: NativeInstallOptions): Promise<void> {
  const paths: NativeInstallResult = resolveInstallPaths(options);
  if (options.platform === "win32") {
    const key: string = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
    await execFileAsync("reg.exe", ["DELETE", key, "/f"]);
  }
  await rm(paths.manifestPath, { force: true });
  await rm(join(options.dataDirectory, "bin"), { recursive: true, force: true });
  await rm(join(options.dataDirectory, "runtime"), { recursive: true, force: true });
}

function resolveInstallPaths(options: NativeInstallOptions): NativeInstallResult {
  const executableName: string = options.platform === "win32" ? "glidea-web2api-host.cmd" : "glidea-web2api-host";
  return {
    hostPath: join(options.dataDirectory, "bin", executableName),
    manifestPath: join(options.manifestDirectory, `${hostName}.json`),
    runtimePath: join(options.dataDirectory, "runtime", "glidea-web2api.cjs")
  };
}

function nativeHostWrapper(platform: NodeJS.Platform, nodePath: string, runtimePath: string): string {
  if (platform === "win32") {
    return `@echo off\r\n"${nodePath}" "${runtimePath}" native-host %*\r\n`;
  }
  return `#!/bin/sh\nexec ${JSON.stringify(nodePath)} ${JSON.stringify(runtimePath)} native-host "$@"\n`;
}
