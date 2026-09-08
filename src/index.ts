import { z } from "zod";

/**
 * The version of the snapshot document this package describes.
 *
 * Bump the MINOR for an additive field, the MAJOR for a removal or a changed
 * meaning. Consumers are expected to keep working across a MINOR bump, so an
 * agent at 1.3 may post to a console that only knows 1.0.
 */
export const SCHEMA_VERSION = "1.0.0";

const Iso = z.string().datetime({ offset: true });

/**
 * What a repository is FOR, which is what decides when it is done.
 *
 *   deployable  ships to an environment; done means deployed and verified
 *   library     published or consumed elsewhere; done means released
 *   docs        prose; done means merged, there is nothing to deploy
 *   manual      finishing it needs a person to do something outside the machine
 *
 * Without this a console has to guess, and the guess is always "deployable" -
 * which leaves a docs repo permanently reported as waiting for a deploy that
 * is never coming.
 */
export const RepoKind = z.enum(["deployable", "library", "docs", "manual"]);
export type RepoKind = z.infer<typeof RepoKind>;

export const Repo = z.object({
  name: z.string(),
  path: z.string(),
  kind: RepoKind,
  defaultBranch: z.string().default("main"),
  head: z.string().optional(),
  dirty: z.boolean().optional(),
});
export type Repo = z.infer<typeof Repo>;

/**
 * The one writable task store for a project. Exactly one per project: a second
 * writable store means two masters and a reconciliation problem nobody wins.
 */
export const Authority = z.object({
  kind: z.enum(["beads", "github", "linear", "jira"]),
  idPrefix: z.string().optional(),
  location: z.string().optional(),
});
export type Authority = z.infer<typeof Authority>;

/**
 * A read-only source of evidence - never a task store. A signal cannot create
 * work on its own; it produces candidates that a person promotes into the
 * authority. That asymmetry is deliberate and is what keeps one master.
 */
export const Signal = z.object({
  kind: z.enum(["sentry", "session-replay", "ci", "uptime", "custom"]),
  name: z.string(),
  location: z.string().optional(),
});
export type Signal = z.infer<typeof Signal>;

/** Where the work for a lane actually runs. */
export const Executor = z.enum(["local", "remote"]);
export type Executor = z.infer<typeof Executor>;

/**
 * A lane is one unit of concurrency. `handed-off` is NOT `working`: a lane that
 * has finished and left a green pull request for the lander still holds its
 * claim on the issue, and counting the two together inflates the in-flight
 * number and starves dispatch.
 *
 * `stranded` means the claim outlived whatever was supposed to be doing the
 * work - the state a supervisor needs to see and nothing else reports.
 */
export const LaneState = z.enum(["working", "handed-off", "idle", "stranded"]);
export type LaneState = z.infer<typeof LaneState>;

export const Lane = z.object({
  slot: z.number().int().positive(),
  state: LaneState,
  executor: Executor.default("local"),
  issueId: z.string().optional(),
  worktree: z.string().optional(),
  lastActivityAt: Iso.optional(),
});
export type Lane = z.infer<typeof Lane>;

/**
 * Why an issue is not simply "open", in the only terms that matter to a person
 * looking at the screen.
 *
 * The `yours:` prefix is load-bearing. It marks the two states that are a
 * person's own queue - a choice only they can make, and an action only they can
 * run - and separates them from everything else that is merely not being worked
 * on. Summing the two groups into a single "waiting on you" figure overstated a
 * real backlog more than fourfold, so the split is encoded here, once, rather
 * than re-derived by each console.
 */
export const Classification = z.enum([
  "yours:decision",
  "yours:access",
  "parked:tooling",
  "parked:watch",
  "parked:umbrella",
  "parked:roadmap",
  "blocked",
  "ready",
  "in-flight",
  "landing",
]);
export type Classification = z.infer<typeof Classification>;

/** The classifications that belong in a person's inbox. Nothing else does. */
export const INBOX_CLASSIFICATIONS = ["yours:decision", "yours:access"] as const;

export function isYours(c: Classification): boolean {
  return (INBOX_CLASSIFICATIONS as readonly string[]).includes(c);
}

/**
 * Whether the reason an issue is parked is still true.
 *
 * An issue records why it stopped; nothing records when that reason expired. A
 * question gets answered in conversation, access gets granted, the branch it was
 * waiting on merges - and the issue goes on advertising a blocker that no longer
 * exists. `unchecked` is the honest default and must be distinguishable from
 * `still-blocking`: "we have not looked" is not the same claim as "we looked and
 * it holds".
 */
export const StalenessVerdict = z.enum([
  "unchecked",
  "still-blocking",
  "likely-stale",
  "resolved",
]);
export type StalenessVerdict = z.infer<typeof StalenessVerdict>;

export const Staleness = z.object({
  verdict: StalenessVerdict.default("unchecked"),
  checkedAt: Iso.optional(),
  evidence: z.array(z.string()).default([]),
});
export type Staleness = z.infer<typeof Staleness>;

export const Issue = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "in_progress", "closed"]),
  issueType: z.string().optional(),
  priority: z.number().int().optional(),
  labels: z.array(z.string()).default([]),
  updatedAt: Iso.optional(),
  createdAt: Iso.optional(),
  blockedBy: z.array(z.string()).default([]),
  classification: Classification,
  staleness: Staleness.default({ verdict: "unchecked", evidence: [] }),
});
export type Issue = z.infer<typeof Issue>;

export const PullRequest = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string().optional(),
  issueId: z.string().optional(),
  checks: z.enum(["green", "red", "pending", "none"]),
  labels: z.array(z.string()).default([]),
  url: z.string().optional(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const Metrics = z.object({
  landedToday: z.number().int().nonnegative().default(0),
  closedToday: z.number().int().nonnegative().default(0),
  readyCount: z.number().int().nonnegative().default(0),
  inboxCount: z.number().int().nonnegative().default(0),
  medianTimeToLandMinutes: z.number().nonnegative().optional(),
  bounceRate: z.number().min(0).max(1).optional(),
});
export type Metrics = z.infer<typeof Metrics>;

/**
 * A source that could not be read.
 *
 * This exists so a partial snapshot cannot masquerade as a complete one. If the
 * tracker query fails, `issues` is empty - which renders identically to a
 * genuinely empty backlog and is the most dangerous thing this document could
 * say. A console must be able to tell "nothing to do" from "we could not look".
 */
export const CollectionError = z.object({
  source: z.string(),
  message: z.string(),
  at: Iso,
});
export type CollectionError = z.infer<typeof CollectionError>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  root: z.string(),
  authority: Authority,
  signals: z.array(Signal).default([]),
  repos: z.array(Repo).default([]),
  lanes: z.array(Lane).default([]),
  issues: z.array(Issue).default([]),
  pipeline: z.array(PullRequest).default([]),
  metrics: Metrics,
  errors: z.array(CollectionError).default([]),
});
export type Project = z.infer<typeof Project>;

export const Snapshot = z.object({
  schemaVersion: z.string(),
  generatedAt: Iso,
  agent: z.object({
    version: z.string(),
    executor: Executor.default("local"),
  }),
  projects: z.array(Project).default([]),
});
export type Snapshot = z.infer<typeof Snapshot>;

/** Parse and validate an unknown value as a Snapshot, throwing on failure. */
export function parseSnapshot(value: unknown): Snapshot {
  return Snapshot.parse(value);
}

/** The issues that are actually somebody's to act on, across every project. */
export function inbox(snapshot: Snapshot): Array<{ project: Project; issue: Issue }> {
  return snapshot.projects.flatMap((project) =>
    project.issues
      .filter((issue) => isYours(issue.classification))
      .map((issue) => ({ project, issue })),
  );
}
