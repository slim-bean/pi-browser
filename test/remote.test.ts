import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { remoteHistory, searchRemoteHistory } from "../extension/remote.ts";

const helper = fileURLToPath(new URL("../bin/history.ts", import.meta.url));
test("stdio helper and remote client use the same query contract, with no local fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-history-remote-"));
  const env = { ...process.env };
  const profile = join(dir, "chrome"); mkdirSync(join(profile, "Default"), { recursive: true });
  const db = new DatabaseSync(join(profile, "Default", "History"));
  db.exec("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER)");
  db.prepare("INSERT INTO urls VALUES (1, ?, ?, 2, ?, 0)").run("https://fixture.example/doc", "Remote fixture", (BigInt(Date.now()) + 11644473600000n) * 1000n);
  db.close();
  const helperEnv = { ...env, PI_BROWSER_HISTORY_CHROMIUM_ROOTS: JSON.stringify([{ browser: "remote-assistant", dir: profile }]), PI_BROWSER_HISTORY_CACHE: join(dir, "cache") };
  const run = (operation: string, params: unknown = {}) => {
    const result = spawnSync(process.execPath, [helper], { input: JSON.stringify({ operation, params }), env: helperEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-token") return res.writeHead(401).end('{"error":"unauthorized"}');
    let body = ""; for await (const data of req) body += data;
    const result = run(req.url?.endsWith("sources") ? "sources" : "search", body ? JSON.parse(body) : {});
    res.writeHead(result.error ? 400 : 200, { "content-type": "application/json" }).end(JSON.stringify(result));
  });
  try {
    assert.equal(run("search", { query: "fixture" }).details.entries[0].title, "Remote fixture");
    assert.equal(run("search", { path: "/etc/passwd" }).code, "bad_request");
    assert.equal(run("search", { limit: 201 }).code, "bad_request");
    const sources = run("sources");
    assert.equal(sources.sources[0].id, "remote-assistant");
    assert.equal(JSON.stringify(sources).includes(profile), false);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.PI_BROWSER_HISTORY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.PI_BROWSER_HISTORY_TOKEN = "wrong";
    delete process.env.PI_BROWSER_HISTORY_TOKEN_FILE;
    await assert.rejects(searchRemoteHistory({ query: "fixture" }), /no local fallback/);
    const token = join(dir, "token"); writeFileSync(token, "fixture-token\n");
    process.env.PI_BROWSER_HISTORY_TOKEN_FILE = token;
    const result = await searchRemoteHistory({ query: "fixture", browsers: ["remote-assistant"], group: "page" });
    assert.equal(result.details.totalMatches, 1);
    assert.match(result.content[0].text, /Remote fixture/);
    assert.equal((await remoteHistory("sources")).sources[0].id, "remote-assistant");
    writeFileSync(token, "rotated-invalid");
    await assert.rejects(searchRemoteHistory({}), /unauthorized/);
  } finally { server.closeAllConnections(); server.close(); process.env = env; rmSync(dir, { recursive: true, force: true }); }
});
