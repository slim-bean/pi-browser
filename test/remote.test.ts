import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { remoteSources, searchRemoteHistory } from "../extension/remote.ts";
import { searchHistory } from "../extension/api.ts";
import { buildQuery } from "../extension/search.ts";
import { parseQuery } from "../extension/query.ts";
import { discoverSources } from "../extension/sources.ts";

test("remote v2 fetches records only; local and remote share filtering, ranking and formatting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-history-remote-"));
  const env = { ...process.env };
  const profile = join(dir, "chrome"); mkdirSync(join(profile, "Default"), { recursive: true });
  const db = new DatabaseSync(join(profile, "Default", "History"));
  db.exec("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER)");
  const now = Date.now();
  const records = [
    ["https://fixture.example/doc", "Remote fixture", 2, now - 1000],
    ["https://fixture.example/doc?variant=1", "Remote fixture", 3, now - 2000],
    ["https://fixture.example/skip", "Skip fixture", 1, now - 3000],
    ["https://other.example/?link=fixture.example", "False host candidate", 1, now - 4000],
    ["https://fixture.example/literal", "100%_literal", 1, now - 5000],
  ] as const;
  for (const [url, title, visits, ms] of records) db.prepare("INSERT INTO urls(url,title,visit_count,last_visit_time,hidden) VALUES(?,?,?,?,0)").run(url, title, visits, (BigInt(ms) + 11644473600000n) * 1000n);
  const source = { id: "remote-assistant/Default", browser: "remote-assistant", profile: "Default", label: "remote-assistant/Default" };
  let protocol = 2; let capped = false; let malformed = false; let queryCount = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-token") return res.writeHead(401).end('{"error":"unauthorized"}');
    res.setHeader("content-type", "application/json");
    if (req.url === "/history/sources") return res.end(JSON.stringify({ version: protocol, sources: [source] }));
    assert.equal(req.url, "/history/query");
    let body = ""; for await (const data of req) body += data;
    const params = JSON.parse(body); queryCount++;
    assert.equal(params.version, 2); assert.equal(params.sourceId, source.id);
    assert.equal(params.query, undefined); assert.equal(params.sort, undefined); assert.equal(params.group, undefined);
    assert.ok(params.limit <= 20000);
    const query = { ...parseQuery(""), terms: params.terms, excluded: params.excluded, hosts: params.hosts, sinceMs: params.sinceMs, untilMs: params.untilMs };
    const built = buildQuery("chromium", query, params.limit);
    const rows = db.prepare(built.sql).all(...built.params);
    if (malformed) rows[0].ms = null;
    res.end(JSON.stringify({ version: protocol, source, rows, truncated: capped }));
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.PI_BROWSER_HISTORY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.PI_BROWSER_HISTORY_TOKEN = "wrong"; delete process.env.PI_BROWSER_HISTORY_TOKEN_FILE;
    await assert.rejects(searchRemoteHistory({ query: "fixture" }), /no local fallback/);
    const token = join(dir, "token"); writeFileSync(token, "fixture-token\n"); process.env.PI_BROWSER_HISTORY_TOKEN_FILE = token;
    const sources = discoverSources({ extraChromiumRoots: [{ browser: source.browser, dir: profile }], includeDefaults: false });
    for (const params of [
      { query: "fixture -skip", sort: "relevance" },
      { site: "fixture.example", group: "site" },
      { query: "%_", sort: "visits" },
      { query: "fixture since:7d", sort: "recent" },
    ]) {
      const remote = await searchRemoteHistory(params);
      const local = searchHistory(params, sources);
      const { elapsedMs: _r, ...remoteDetails } = remote.details;
      const { elapsedMs: _l, ...localDetails } = local.details;
      assert.deepEqual(remoteDetails, localDetails);
    }
    assert.equal((await remoteSources()).sources[0].id, source.id);
    capped = true;
    const partial = await searchRemoteHistory({ query: "fixture" });
    assert.equal(partial.details.truncated, true); assert.match(partial.content[0].text, /Row cap reached/);
    malformed = true; await assert.rejects(searchRemoteHistory({ query: "fixture" }), /Invalid remote history record/); malformed = false;
    protocol = 1; const before = queryCount;
    await assert.rejects(searchRemoteHistory({}), /native history v2/); assert.equal(queryCount, before); protocol = 2;
    await assert.rejects(searchRemoteHistory({ path: "/etc/passwd" }), /Unknown history parameter/);
    writeFileSync(token, "rotated-invalid"); await assert.rejects(searchRemoteHistory({}), /unauthorized/);
  } finally { db.close(); server.closeAllConnections(); server.close(); process.env = env; rmSync(dir, { recursive: true, force: true }); }
});
