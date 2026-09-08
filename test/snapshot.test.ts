import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  Snapshot,
  parseSnapshot,
  isYours,
  inbox,
  Classification,
  INBOX_CLASSIFICATIONS,
  Origin,
  resolveOrigin,
} from "../src/index.ts";

const minimal = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  agent: { version: "0.1.0" },
  projects: [],
};

test("a minimal snapshot parses and defaults the executor", () => {
  const snap = parseSnapshot(minimal);
  assert.equal(snap.agent.executor, "local");
  assert.deepEqual(snap.projects, []);
});

test("a snapshot without generatedAt is rejected", () => {
  assert.throws(() => parseSnapshot({ ...minimal, generatedAt: undefined }));
});

test("only the yours: classifications count as somebody's queue", () => {
  const yours = Classification.options.filter(isYours);
  assert.deepEqual(yours, [...INBOX_CLASSIFICATIONS]);
});

test("parked and in-flight work is never in the inbox", () => {
  for (const c of ["parked:tooling", "parked:watch", "parked:umbrella",
                   "parked:roadmap", "blocked", "ready", "in-flight", "landing"] as const) {
    assert.equal(isYours(c), false, `${c} must not be treated as somebody's queue`);
  }
});

test("inbox() gathers only the owner's issues across projects", () => {
  const issue = (id: string, classification: string) => ({
    id, title: id, status: "open", classification,
  });
  const project = (id: string, issues: unknown[]) => ({
    id, name: id, root: `/tmp/${id}`,
    authority: { kind: "beads" },
    metrics: {},
    issues,
  });

  const snap = parseSnapshot({
    ...minimal,
    projects: [
      project("a", [issue("a-1", "yours:decision"), issue("a-2", "ready")]),
      project("b", [issue("b-1", "yours:access"), issue("b-2", "parked:roadmap")]),
    ],
  });

  assert.deepEqual(inbox(snap).map((e) => e.issue.id), ["a-1", "b-1"]);
});

test("staleness defaults to unchecked, which is not a claim that it still blocks", () => {
  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      issues: [{ id: "a-1", title: "t", status: "open", classification: "yours:decision" }],
    }],
  });
  assert.equal(snap.projects[0]!.issues[0]!.staleness.verdict, "unchecked");
});

test("a project records the sources it could not read", () => {
  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      errors: [{ source: "beads", message: "bd exited 1", at: new Date().toISOString() }],
    }],
  });
  assert.equal(snap.projects[0]!.errors.length, 1);
  assert.deepEqual(snap.projects[0]!.issues, []);
});

test("the schema accepts a repo of every kind", () => {
  for (const kind of ["deployable", "library", "docs", "manual"] as const) {
    const snap = parseSnapshot({
      ...minimal,
      projects: [{
        id: "a", name: "a", root: "/tmp/a",
        authority: { kind: "beads" }, metrics: {},
        repos: [{ name: "r", path: "r", kind }],
      }],
    });
    assert.equal(snap.projects[0]!.repos[0]!.defaultBranch, "main");
  }
});

test("Snapshot is exported as a usable zod schema", () => {
  assert.equal(typeof Snapshot.safeParse, "function");
  assert.equal(Snapshot.safeParse({}).success, false);
});

test("an issue may carry the session that asked for it", () => {
  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      issues: [{
        id: "a-1", title: "t", status: "open", classification: "ready",
        origin: { session: "planning", ref: "c1796a" },
      }],
    }],
  });
  assert.deepEqual(snap.projects[0]!.issues[0]!.origin, { session: "planning", ref: "c1796a" });
});

test("origin is optional - most issues predate the convention", () => {
  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      issues: [{ id: "a-1", title: "t", status: "open", classification: "ready" }],
    }],
  });
  assert.equal(snap.projects[0]!.issues[0]!.origin, undefined);
});

test("an origin missing its ref is rejected - the ref is the address", () => {
  assert.throws(() => Origin.parse({ session: "planning" }));
  assert.throws(() => Origin.parse({ ref: "c1796a" }));
});

test("resolveOrigin walks up the id when a child did not inherit one", () => {
  const parent = { id: "p-1", origin: { session: "planning", ref: "c1796a" } };
  const child = { id: "p-1.2", origin: undefined };
  const grandchild = { id: "p-1.2.3", origin: undefined };
  const byId = new Map([parent, child, grandchild].map((i) => [i.id, i]));

  assert.deepEqual(resolveOrigin(child, byId), parent.origin);
  assert.deepEqual(resolveOrigin(grandchild, byId), parent.origin);
});

test("resolveOrigin prefers the issue's own origin over an ancestor's", () => {
  const own = { session: "other", ref: "zzz" };
  const parent = { id: "p-1", origin: { session: "planning", ref: "c1796a" } };
  const child = { id: "p-1.2", origin: own };
  const byId = new Map([parent, child].map((i) => [i.id, i]));

  assert.deepEqual(resolveOrigin(child, byId), own);
});

test("resolveOrigin returns undefined when no ancestor has one", () => {
  const child = { id: "p-1.2", origin: undefined };
  const byId = new Map([["p-1", { id: "p-1", origin: undefined }], [child.id, child]]);
  assert.equal(resolveOrigin(child, byId), undefined);
  assert.equal(resolveOrigin({ id: "top", origin: undefined }, byId), undefined);
});

test("the contract version reflects an additive change", () => {
  const [major, minor] = SCHEMA_VERSION.split(".");
  assert.equal(major, "1", "origin is additive - it must not force a major bump");
  assert.equal(minor, "1");
});
