<!-- Absolute URLs: npmjs.com renders this file and resolves relative paths against its
     own host. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/404sl/pitwall/master/ui/brand/logo/pitwall-lockup-dark.svg">
  <img alt="Pitwall" src="https://raw.githubusercontent.com/404sl/pitwall/master/ui/brand/logo/pitwall-lockup-light.svg" width="240">
</picture>

# @404sl/pitwall-schema

The Pitwall snapshot contract: the versioned shape of the document an agent
produces and every console consumes.

MIT, deliberately. Pitwall itself is AGPL, but nobody should have to adopt a
copyleft licence to write an adapter for their own tracker.

## What a snapshot is

One normalised description of the state of every project an agent can see -
repositories, lanes, issues, open pull requests and metrics - taken at a moment
in time.

Most of it is gathered. Two fields are computed, and they are the reason this
document exists:

- **`classification`** - why an issue is not simply "open", in the terms that
  matter to a person. The `yours:` prefix marks the only two states that are
  somebody's own queue: a decision only they can make, and an action only they
  can run. Everything else is parked, blocked or being worked.
- **`staleness`** - whether the reason an issue stopped is still true. An issue
  records why it was parked; nothing records when that reason expired.

## Why the rules live here

`isYours()` and `INBOX_CLASSIFICATIONS` are exported rather than reimplemented
per console. Summing every parked issue into one "waiting on you" figure
overstated a real backlog more than fourfold - 74 against an actual 17 - so what
counts as somebody's queue is defined once, in the contract, where two consumers
cannot drift apart on it.

The same reasoning covers `errors[]`. A tracker query that fails leaves `issues`
empty, which renders exactly like a genuinely empty backlog. A console has to be
able to tell "nothing to do" from "we could not look".

## Use

```ts
import { parseSnapshot, inbox, SCHEMA_VERSION } from "@404sl/pitwall-schema";

const snapshot = parseSnapshot(JSON.parse(raw));
for (const { project, issue } of inbox(snapshot)) {
  console.log(project.name, issue.id, issue.staleness.verdict);
}
```

Consumers that are not TypeScript validate against the emitted JSON Schema:

```
@404sl/pitwall-schema/pitwall-snapshot.schema.json
```

Both are generated from the same definitions.

## Versioning

`SCHEMA_VERSION` tracks the document, not the package. Bump the minor for an
additive field, the major for a removal or a change of meaning. A console that
understands 1.0 must keep working against an agent emitting 1.3 - version skew
is normal the moment more than one machine is involved.
