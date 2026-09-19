import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readJson(relative: string) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
}

test("the lock file carries the same package version as package.json", () => {
  const manifest = readJson("../package.json");
  const lock = readJson("../package-lock.json");

  assert.equal(lock.version, manifest.version, "package-lock.json top-level version is behind package.json");
  assert.equal(lock.packages[""].version, manifest.version, "package-lock.json root package version is behind package.json");
});
