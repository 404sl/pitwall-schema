import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  SCHEMA_VERSION,
  Snapshot,
  parseSnapshot,
  isYours,
  inbox,
  Classification,
  INBOX_CLASSIFICATIONS,
  Issue,
  Origin,
  Project,
  PullRequest,
  Candidate,
  Signal,
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
  for (const c of ["parked:call", "parked:tooling", "parked:watch", "parked:umbrella",
                   "parked:roadmap", "blocked", "ready", "in-flight", "landing",
                   "unknown"] as const) {
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

test("an uncomputed landedToday stays undefined rather than standing in as zero", () => {
  const metrics = (m: unknown) => parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: m,
    }],
  }).projects[0]!.metrics;

  assert.equal(metrics({}).landedToday, undefined);
  assert.equal(metrics({}).closedToday, 0);
  assert.equal(metrics({ landedToday: 0 }).landedToday, 0);
  assert.equal(metrics({ landedToday: 3 }).landedToday, 3);
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
    assert.equal(snap.projects[0]!.repos[0]!.kind, kind);
  }
});

test("a repo with no defaultBranch reports none rather than claiming main", () => {
  const parse = (repo: Record<string, unknown>) =>
    parseSnapshot({
      ...minimal,
      projects: [{
        id: "a", name: "a", root: "/tmp/a",
        authority: { kind: "beads" }, metrics: {},
        repos: [repo],
      }],
    }).projects[0]!.repos[0]!;

  assert.equal(parse({ name: "r", path: "r", kind: "library" }).defaultBranch, undefined);
  assert.equal(
    parse({ name: "r", path: "r", kind: "library", defaultBranch: "master" }).defaultBranch,
    "master",
  );
});

test("the emitted JSON Schema neither requires defaultBranch nor defaults it, and says what absence means", () => {
  const schema = z.toJSONSchema(Snapshot, { io: "output" }) as Record<string, any>;
  const repo = schema["properties"].projects.items.properties.repos.items;

  assert.equal(repo.required.includes("defaultBranch"), false);
  assert.equal("default" in repo.properties.defaultBranch, false);
  assert.match(repo.properties.defaultBranch.description, /did not read it/);
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

test("additive changes do not force a major bump", () => {
  // Pins the MAJOR only. An earlier version of this test also pinned the minor,
  // which made it fail on the next additive field - the exact change it exists to
  // permit. A test that has to be edited by every change it is meant to allow is
  // not protecting anything.
  const [major] = SCHEMA_VERSION.split(".");
  assert.equal(major, "1");
  assert.match(SCHEMA_VERSION, /^\d+\.\d+\.\d+$/);
});

test("a snapshot records a failure that belongs to the run, not to a project", () => {
  const snap = parseSnapshot({
    ...minimal,
    errors: [{ source: "config", message: "roots is not an array of strings",
               at: new Date().toISOString() }],
  });
  assert.equal(snap.errors.length, 1);
  assert.equal(snap.errors[0]!.source, "config");
});

test("run-level errors default to empty and are never undefined", () => {
  assert.deepEqual(parseSnapshot(minimal).errors, []);
});

test("a broken config is distinguishable from a run that found nothing", () => {
  const foundNothing = parseSnapshot(minimal);
  const couldNotLook = parseSnapshot({
    ...minimal,
    errors: [{ source: "config", message: "unreadable", at: new Date().toISOString() }],
  });
  assert.deepEqual(foundNothing.projects, couldNotLook.projects);
  assert.notDeepEqual(foundNothing.errors, couldNotLook.errors);
});

test("a pull request that does not report drafts is read as ready, not as unknown", () => {
  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      pipeline: [{ repo: "r", number: 7, checks: "green" }],
    }],
  });
  assert.equal(snap.projects[0]!.pipeline[0]!.draft, false);
});

test("a draft pull request is distinguishable from a ready one", () => {
  const pipeline = (draft: unknown) => parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      pipeline: [{ repo: "r", number: 7, checks: "green", draft }],
    }],
  }).projects[0]!.pipeline[0]!;

  assert.equal(pipeline(true).draft, true);
  assert.equal(pipeline(false).draft, false);
});

test("draft is a boolean, not whatever a collector happened to put there", () => {
  assert.throws(() => PullRequest.parse({ repo: "r", number: 7, checks: "green", draft: "yes" }));
  assert.equal(PullRequest.parse({ repo: "r", number: 7, checks: "green" }).draft, false);
});

test("a project reports which workspace file it was read from", () => {
  const project = (workspaceFile: unknown) => parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a", workspaceFile,
      authority: { kind: "beads" }, metrics: {},
    }],
  }).projects[0]!;

  assert.equal(project(".pitwall.json").workspaceFile, ".pitwall.json");
  assert.equal(project(".autofix.json").workspaceFile, ".autofix.json");
  assert.notEqual(project(".pitwall.json").workspaceFile, project(".autofix.json").workspaceFile);
});

test("a project that names no workspace file still parses and claims none", () => {
  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
    }],
  });
  assert.equal(snap.projects[0]!.workspaceFile, undefined);
});

test("workspaceFile is a name, not a boolean saying whether a file was found", () => {
  const project = { id: "a", name: "a", root: "/tmp/a", authority: { kind: "beads" }, metrics: {} };
  assert.throws(() => Project.parse({ ...project, workspaceFile: true }));
});

test("the emitted JSON Schema carries workspaceFile, and does not require it", () => {
  const schema = z.toJSONSchema(Snapshot, { io: "output" }) as Record<string, any>;
  const project = schema["properties"].projects.items;
  assert.equal(project.properties.workspaceFile.type, "string");
  assert.equal(project.required.includes("workspaceFile"), false);
});

test("github is a signal kind, so the first real signal source can name itself", () => {
  for (const kind of ["sentry", "session-replay", "ci", "uptime", "github", "custom"] as const) {
    assert.equal(Signal.parse({ kind, name: "s" }).kind, kind);
  }
});

test("a project carries the candidates its signals found, and parsing keeps them", () => {
  const createdAt = new Date().toISOString();
  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      signals: [{ kind: "github", name: "404sl/pitwall issues" }],
      candidates: [{
        source: "404sl/pitwall issues",
        ref: "404sl/pitwall#7",
        title: "snapshot omits lane 3",
        repo: "404sl/pitwall",
        url: "https://github.com/404sl/pitwall/issues/7",
        author: "elik-ru",
        createdAt,
      }],
    }],
  });

  assert.deepEqual(snap.projects[0]!.candidates, [{
    source: "404sl/pitwall issues",
    ref: "404sl/pitwall#7",
    title: "snapshot omits lane 3",
    repo: "404sl/pitwall",
    url: "https://github.com/404sl/pitwall/issues/7",
    author: "elik-ru",
    createdAt,
  }]);
});

test("a project whose signals found nothing carries an empty candidate list", () => {
  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
    }],
  });
  assert.deepEqual(snap.projects[0]!.candidates, []);
});

test("a candidate must say what produced it, where it lives and what it is", () => {
  const candidate = { source: "s", ref: "r", title: "t" };
  assert.deepEqual(Candidate.parse(candidate), candidate);
  assert.throws(() => Candidate.parse({ ref: "r", title: "t" }));
  assert.throws(() => Candidate.parse({ source: "s", title: "t" }));
  assert.throws(() => Candidate.parse({ source: "s", ref: "r" }));
});

test("an unreported candidate author stays absent rather than standing in as a value", () => {
  const parsed = Candidate.parse({ source: "s", ref: "r", title: "t" });
  assert.equal(parsed.author, undefined);
  assert.equal(Object.hasOwn(parsed, "author"), false);
});

test("a candidate cannot carry a classification - it is evidence, not work", () => {
  const parsed = Candidate.parse({
    source: "s", ref: "r", title: "t", classification: "ready", status: "open",
  }) as Record<string, unknown>;
  assert.equal(parsed["classification"], undefined);
  assert.equal(parsed["status"], undefined);
});

test("the emitted JSON Schema carries candidates and the github signal kind", () => {
  const schema = z.toJSONSchema(Snapshot, { io: "output" }) as Record<string, any>;
  const project = schema["properties"].projects.items;

  assert.equal(project.properties.candidates.type, "array");
  assert.equal(project.required.includes("candidates"), true);

  const candidate = project.properties.candidates.items;
  assert.deepEqual(candidate.required, ["source", "ref", "title"]);
  assert.equal(candidate.properties.author.type, "string");

  assert.equal(project.properties.signals.items.properties.kind.enum.includes("github"), true);
});

test("parked:call is a classification, and a decision that is not the owner's stays out of the inbox", () => {
  assert.equal(Classification.parse("parked:call"), "parked:call");
  assert.equal(isYours("parked:call"), false);
  assert.deepEqual([...INBOX_CLASSIFICATIONS], ["yours:decision", "yours:access"]);

  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      issues: [
        { id: "a-1", title: "which of three shapes", status: "open", classification: "parked:call" },
        { id: "a-2", title: "what the product is called", status: "open", classification: "yours:decision" },
      ],
    }],
  });

  assert.deepEqual(inbox(snap).map((e) => e.issue.id), ["a-2"]);
});

test("the emitted JSON Schema carries parked:call", () => {
  const schema = z.toJSONSchema(Snapshot, { io: "output" }) as Record<string, any>;
  const issue = schema["properties"].projects.items.properties.issues.items;

  assert.equal(issue.properties.classification.enum.includes("parked:call"), true);
  assert.equal(issue.properties.classification.enum.includes("yours:decision"), true);
});

test("a snapshot carries a different read time per project, so one can be older than the run", () => {
  const generatedAt = "2026-09-10T12:00:00.000Z";
  const keptAt = "2026-09-08T09:30:00.000Z";
  const snap = parseSnapshot({
    ...minimal,
    generatedAt,
    projects: [
      {
        id: "fresh", name: "fresh", root: "/tmp/fresh",
        authority: { kind: "beads" }, metrics: {},
        issuesReadAt: generatedAt,
        issues: [{ id: "fresh-1", title: "t", status: "open", classification: "ready" }],
      },
      {
        id: "kept", name: "kept", root: "/tmp/kept",
        authority: { kind: "beads" }, metrics: {},
        issuesReadAt: keptAt,
        issues: [{ id: "kept-1", title: "t", status: "open", classification: "blocked" }],
        errors: [{ source: "authority", message: "bd exited 1", at: generatedAt }],
      },
    ],
  });

  const [fresh, kept] = snap.projects as [Project, Project];
  assert.equal(fresh.issuesReadAt, generatedAt);
  assert.equal(kept.issuesReadAt, keptAt);
  assert.notEqual(fresh.issuesReadAt, kept.issuesReadAt);
  assert.ok(Date.parse(kept.issuesReadAt!) < Date.parse(snap.generatedAt));
  assert.equal(Date.parse(fresh.issuesReadAt!), Date.parse(snap.generatedAt));
});

test("a project that reports no read time claims none rather than inheriting the run's", () => {
  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
    }],
  });
  assert.equal(snap.projects[0]!.issuesReadAt, undefined);
  assert.notEqual(snap.projects[0]!.issuesReadAt, snap.generatedAt);
});

test("issuesReadAt is a timestamp, not whatever a collector happened to put there", () => {
  const project = { id: "a", name: "a", root: "/tmp/a", authority: { kind: "beads" }, metrics: {} };
  assert.throws(() => Project.parse({ ...project, issuesReadAt: "yesterday" }));
  assert.throws(() => Project.parse({ ...project, issuesReadAt: 1757505600000 }));
  assert.equal(
    Project.parse({ ...project, issuesReadAt: "2026-09-10T12:00:00.000Z" }).issuesReadAt,
    "2026-09-10T12:00:00.000Z",
  );
});

test("the emitted JSON Schema carries issuesReadAt as a date-time, and does not require it", () => {
  const schema = z.toJSONSchema(Snapshot, { io: "output" }) as Record<string, any>;
  const project = schema["properties"].projects.items;

  assert.equal(project.properties.issuesReadAt.type, "string");
  assert.equal(project.properties.issuesReadAt.format, "date-time");
  assert.equal(project.properties.issuesReadAt.format, schema["properties"].generatedAt.format);
  assert.equal(project.required.includes("issuesReadAt"), false);
});

test("unknown is a classification, and an issue whose board could not be read stays out of the inbox", () => {
  assert.equal(Classification.parse("unknown"), "unknown");
  assert.equal(isYours("unknown"), false);
  assert.deepEqual([...INBOX_CLASSIFICATIONS], ["yours:decision", "yours:access"]);

  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      errors: [{ source: "beads", message: "bd exited 1", at: new Date().toISOString() }],
      issues: [
        { id: "a-1", title: "whatever the board would have said", status: "open", classification: "unknown" },
        { id: "a-2", title: "what the product is called", status: "open", classification: "yours:decision" },
      ],
    }],
  });

  assert.deepEqual(inbox(snap).map((e) => e.issue.id), ["a-2"]);
  assert.equal(snap.projects[0]!.issues[0]!.classification, "unknown");
});

test("classification stays required, so an unreadable board cannot omit it", () => {
  assert.throws(() => parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      issues: [{ id: "a-1", title: "t", status: "open" }],
    }],
  }));
});

test("the emitted JSON Schema carries unknown", () => {
  const schema = z.toJSONSchema(Snapshot, { io: "output" }) as Record<string, any>;
  const issue = schema["properties"].projects.items.properties.issues.items;

  assert.equal(issue.properties.classification.enum.includes("unknown"), true);
  assert.equal(issue.required.includes("classification"), true);
});

test("an issue carries whose queue it is in and who asked for it", () => {
  const snap = parseSnapshot({
    ...minimal,
    projects: [{
      id: "a", name: "a", root: "/tmp/a",
      authority: { kind: "beads" }, metrics: {},
      issues: [{
        id: "a-1", title: "t", status: "open", classification: "ready",
        owner: "pitwall-devloop", reporter: "pitwall-planning-session",
      }],
    }],
  });

  const issue = snap.projects[0]!.issues[0]!;
  assert.equal(issue.owner, "pitwall-devloop");
  assert.equal(issue.reporter, "pitwall-planning-session");
});

test("owner and reporter are separate - the session working it is not the session that asked", () => {
  const issue = Issue.parse({
    id: "a-1", title: "t", status: "open", classification: "ready",
    owner: "pitwall-devloop", reporter: "pitwall-planning-session",
  });
  assert.notEqual(issue.owner, issue.reporter);
});

test("an unassigned issue stays absent rather than standing in as a value", () => {
  const issue = Issue.parse({ id: "a-1", title: "t", status: "open", classification: "ready" });

  assert.equal(issue.owner, undefined);
  assert.equal(issue.reporter, undefined);
  assert.equal(Object.hasOwn(issue, "owner"), false);
  assert.equal(Object.hasOwn(issue, "reporter"), false);
});

test("owner and reporter are session names, not whatever a collector happened to put there", () => {
  const base = { id: "a-1", title: "t", status: "open", classification: "ready" };
  assert.throws(() => Issue.parse({ ...base, owner: 42 }));
  assert.throws(() => Issue.parse({ ...base, reporter: { name: "planning" } }));
  assert.throws(() => Issue.parse({ ...base, owner: ["a", "b"] }));
});

test("an issue carrying one of the two still parses, and claims nothing about the other", () => {
  const base = { id: "a-1", title: "t", status: "open", classification: "ready" };

  assert.equal(Issue.parse({ ...base, owner: "pitwall-devloop" }).reporter, undefined);
  assert.equal(Issue.parse({ ...base, reporter: "pitwall-planning-session" }).owner, undefined);
});

test("owner and reporter sit beside origin rather than replacing it", () => {
  const issue = Issue.parse({
    id: "a-1", title: "t", status: "open", classification: "ready",
    owner: "pitwall-devloop", reporter: "pitwall-planning-session",
    origin: { session: "pitwall-planning-session", ref: "843c93" },
  });

  assert.deepEqual(issue.origin, { session: "pitwall-planning-session", ref: "843c93" });
  assert.equal(issue.reporter, "pitwall-planning-session");
});

test("the emitted JSON Schema carries owner and reporter, requires neither and defaults neither", () => {
  const schema = z.toJSONSchema(Snapshot, { io: "output" }) as Record<string, any>;
  const issue = schema["properties"].projects.items.properties.issues.items;

  for (const field of ["owner", "reporter"] as const) {
    assert.equal(issue.properties[field].type, "string");
    assert.equal(issue.required.includes(field), false);
    assert.equal("default" in issue.properties[field], false);
  }

  assert.match(issue.properties.owner.description, /never a git identity/);
  assert.match(issue.properties.reporter.description, /Distinct from `origin`/);
});
