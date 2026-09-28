import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredChromiumRoots, discoverSources, filterSources } from "../extension/sources.ts";

test("custom assistant history root, attribution, filtering, and path deduplication", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-history-test-"));
  const previous = process.env.PI_BROWSER_HISTORY_CHROMIUM_ROOTS;
  try {
    mkdirSync(join(dir, "Default"));
    writeFileSync(join(dir, "Default", "History"), "synthetic nonempty fixture");
    process.env.PI_BROWSER_HISTORY_CHROMIUM_ROOTS = JSON.stringify([{ browser: "assistant", dir }, { browser: "duplicate", dir }]);
    const sources = discoverSources({ includeDefaults: false });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, "assistant");
    assert.equal(filterSources(sources, ["assistant"]).length, 1);
    assert.equal(filterSources(sources, ["chrome"]).length, 0);
    process.env.PI_BROWSER_HISTORY_CHROMIUM_ROOTS = "invalid";
    assert.throws(configuredChromiumRoots, /JSON array/);
    process.env.PI_BROWSER_HISTORY_CHROMIUM_ROOTS = '[{"browser":"Bad Label","dir":"/tmp"}]';
    assert.throws(configuredChromiumRoots, /lowercase-id/);
  } finally {
    if (previous === undefined) delete process.env.PI_BROWSER_HISTORY_CHROMIUM_ROOTS;
    else process.env.PI_BROWSER_HISTORY_CHROMIUM_ROOTS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
