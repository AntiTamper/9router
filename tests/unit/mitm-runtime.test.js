import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

let tempDir;
let previousDataDir;

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

function loadManager() {
  const managerPath = require.resolve("../../src/mitm/manager.js");
  const pathsPath = require.resolve("../../src/mitm/paths.js");
  delete require.cache[managerPath];
  delete require.cache[pathsPath];
  return require("../../src/mitm/manager.js");
}

describe("MITM runtime packaging", () => {
  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mitm-test-"));
    process.env.DATA_DIR = path.join(tempDir, "data");
  });

  afterEach(() => {
    if (previousDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("copies the MITM source layout so relative requires keep working", () => {
    const packageRoot = path.join(tempDir, "node_modules", "9router");
    const serverPath = path.join(packageRoot, "src", "mitm", "server.js");
    write(
      serverPath,
      `
        module.exports = {
          handler: require("./handlers/test-handler.js"),
          hosts: require("./dns/dnsConfig.js").TOOL_HOSTS,
        };
      `,
    );
    write(path.join(packageRoot, "src", "mitm", "handlers", "test-handler.js"), "module.exports = { ok: true };\n");
    write(
      path.join(packageRoot, "src", "mitm", "dns", "dnsConfig.js"),
      "module.exports = require('../../shared/constants/mitmToolHosts.js');\n",
    );
    write(
      path.join(packageRoot, "src", "shared", "constants", "mitmToolHosts.js"),
      "module.exports = { TOOL_HOSTS: { antigravity: ['cloudcode-pa.googleapis.com'] } };\n",
    );

    const manager = loadManager();
    const runtimeServer = manager._test.ensureRuntimeServer(serverPath);
    const loaded = require(runtimeServer);

    expect(runtimeServer).not.toBe(serverPath);
    expect(runtimeServer).toContain(path.join("runtime", "mitm-src-"));
    expect(loaded.handler).toEqual({ ok: true });
    expect(loaded.hosts.antigravity).toEqual(["cloudcode-pa.googleapis.com"]);
  });

  it("keeps package node_modules resolvable for copied runtime files", () => {
    const packageRoot = path.join(tempDir, "node_modules", "9router");
    const serverPath = path.join(packageRoot, "src", "mitm", "server.js");
    fs.mkdirSync(path.join(packageRoot, "node_modules"), { recursive: true });
    write(serverPath, "module.exports = {};\n");

    const manager = loadManager();
    const nodePath = manager._test.findPackageNodePaths(serverPath);

    expect(nodePath.split(path.delimiter)).toContain(path.join(packageRoot, "node_modules"));
  });
});
