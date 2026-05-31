import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let getAdapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-rdprov-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ getAdapter } = await import("@/lib/db/driver.js"));
}, 30_000);

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function seed(rows) {
  const adapter = await getAdapter();
  let i = 0;
  for (const r of rows) {
    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [`id-${Date.now()}-${i++}`, new Date().toISOString(), r.provider, "m", "c", "ok", "{}"],
    );
  }
}

describe("getRequestDetailProviders", () => {
  it("returns sorted distinct providers, ignoring null/empty", async () => {
    await seed([
      { provider: "openai" }, { provider: "anthropic" },
      { provider: "openai" }, { provider: "google" },
      { provider: null }, { provider: "" },
    ]);

    const providers = await db.getRequestDetailProviders();
    expect(providers).toEqual(["anthropic", "google", "openai"]);
  });
});

describe("getRequestDetails pagination clamp", () => {
  it("clamps oversized pageSize to the max", async () => {
    const result = await db.getRequestDetails({ pageSize: 99999 });
    expect(result.pagination.pageSize).toBeLessThanOrEqual(500);
  });

  it("floors invalid page/pageSize to safe defaults", async () => {
    const result = await db.getRequestDetails({ page: -5, pageSize: 0 });
    expect(result.pagination.page).toBeGreaterThanOrEqual(1);
    expect(result.pagination.pageSize).toBeGreaterThanOrEqual(1);
  });
});