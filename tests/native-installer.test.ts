// @vitest-environment node

import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectNativeHost, installBundledExtension, installNativeHost, uninstallNativeHost, type NativeInstallOptions, type NativeInstallResult } from "../src/native/installer";

const extensionId: string = "abcdefghijklmnopabcdefghijklmnop";

describe("native host installer", (): void => {
  it("copies the bundled extension to a stable user directory", async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), "web2api-extension-install-"));
    const runtimeDirectory: string = join(root, "package", "dist");
    const runtimeSource: string = join(runtimeDirectory, "glidea-web2api.cjs");
    const extensionSource: string = join(runtimeDirectory, "extension");
    const dataDirectory: string = join(root, "data");
    await mkdir(extensionSource, { recursive: true });
    await writeFile(join(extensionSource, "manifest.json"), "{}\n", "utf8");

    try {
      const extensionPath: string = await installBundledExtension(runtimeSource, dataDirectory);

      expect(extensionPath).toBe(join(dataDirectory, "extension"));
      await expect(readFile(join(extensionPath, "manifest.json"), "utf8")).resolves.toBe("{}\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies a stable runtime and registers the current extension on macOS", async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), "web2api-native-install-"));
    const source: string = join(root, "source.mjs");
    const dataDirectory: string = join(root, "data");
    const manifestDirectory: string = join(root, "NativeMessagingHosts");
    await writeFile(source, "console.log('runtime');\n", "utf8");
    await chmod(source, 0o755);
    const options: NativeInstallOptions = {
      platform: "darwin",
      extensionId,
      dataDirectory,
      manifestDirectory,
      runtimeSource: source,
      nodePath: process.execPath
    };

    try {
      const installed: NativeInstallResult = await installNativeHost(options);
      const manifest: { name: string; path: string; allowed_origins: string[] } = JSON.parse(await readFile(installed.manifestPath, "utf8")) as { name: string; path: string; allowed_origins: string[] };
      const wrapper: string = await readFile(installed.hostPath, "utf8");
      const runtime: string = await readFile(installed.runtimePath, "utf8");

      expect(manifest).toEqual({
        name: "dev.glidea.web2api",
        description: "Glidea Web2API native host",
        path: installed.hostPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`]
      });
      expect(wrapper).toContain(JSON.stringify(process.execPath));
      expect(wrapper).toContain(JSON.stringify(installed.runtimePath));
      expect(runtime).toBe("console.log('runtime');\n");
      expect((await stat(installed.hostPath)).mode & 0o111).not.toBe(0);
      await expect(inspectNativeHost(options)).resolves.toEqual({ installed: true, ...installed });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the registration and installed runtime", async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), "web2api-native-uninstall-"));
    const source: string = join(root, "source.mjs");
    const options: NativeInstallOptions = {
      platform: "darwin",
      extensionId,
      dataDirectory: join(root, "data"),
      manifestDirectory: join(root, "NativeMessagingHosts"),
      runtimeSource: source,
      nodePath: process.execPath
    };
    await writeFile(source, "", "utf8");

    try {
      await installNativeHost(options);
      await uninstallNativeHost(options);
      await expect(inspectNativeHost(options)).resolves.toEqual({ installed: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
