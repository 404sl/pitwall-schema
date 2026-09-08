/**
 * Emit the JSON Schema artifact alongside the compiled types.
 *
 * The server that ingests snapshots is not written in TypeScript and cannot
 * import the zod definitions, so it validates against this file instead. Both
 * come out of the same source, which is the point: one definition, two
 * consumers, no chance of the two drifting apart unnoticed.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Snapshot, SCHEMA_VERSION } from "../src/index.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
mkdirSync(out, { recursive: true });

const schema = {
  $id: `https://pitwall.build/schema/${SCHEMA_VERSION}/snapshot.json`,
  title: "Pitwall snapshot",
  ...z.toJSONSchema(Snapshot, { io: "output" }),
};

const path = join(out, "pitwall-snapshot.schema.json");
writeFileSync(path, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${path}`);
