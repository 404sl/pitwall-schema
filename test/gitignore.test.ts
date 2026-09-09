import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const shippedIgnoreFile = fileURLToPath(new URL("../.gitignore", import.meta.url));

function git(cwd: string, ...args: string[]) {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: ran.status, stdout: ran.stdout ?? "" };
}

function checkoutSharingDependencies(): string {
  const checkout = mkdtempSync(join(tmpdir(), "pitwall-schema-ignore-"));
  const dependencies = mkdtempSync(join(tmpdir(), "pitwall-schema-deps-"));
  mkdirSync(join(dependencies, "zod"), { recursive: true });

  assert.equal(git(checkout, "init", "--quiet").status, 0, "the throwaway checkout was not created");
  copyFileSync(shippedIgnoreFile, join(checkout, ".gitignore"));
  symlinkSync(dependencies, join(checkout, "node_modules"));
  return checkout;
}

test("a node_modules shared in as a symlink is ignored", () => {
  const checkout = checkoutSharingDependencies();

  const ignored = git(checkout, "check-ignore", "-v", "node_modules");
  assert.equal(ignored.status, 0, "no .gitignore rule matches a node_modules symlink");
  assert.match(ignored.stdout, /\.gitignore:\d+:node_modules\s/);

  const status = git(checkout, "status", "--porcelain");
  assert.equal(status.status, 0);
  assert.ok(!status.stdout.includes("node_modules"), "a shared node_modules is reported as untracked");
});
