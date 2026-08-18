/**
 * @file derive-iss4592-oracle-amendments.ts
 * @description ISS-4592 Layer-1 oracle amendment PROPOSAL generator
 * (agent-generated, HUMAN-applied — this tool never writes into
 * packages/golden-sessions; it refuses an output dir inside the corpus).
 *
 * Modelled directly on `derive-fea3597-oracle-amendments.ts`: temp-copy raw/
 * (inside parseDossierRaw), run the PRODUCTION parser, project through the SAME
 * `jsonNormalize` the Layer-1 deep-equal uses (so compare semantics and
 * proposals can never drift), preserve the frozen capture-time
 * `fileModifiedAt`, serialize with plain JSON.stringify(,,2).
 *
 * The delta ISS-4592 authorizes is the delegation kickoff landing on
 * `subagents[]`: `type`, `task`, `metadata.spawnedByToolUseId`, and
 * `metadata.description`. Two independent gates prove a proposal carries
 * nothing else, and the run exits 1 rather than writing if either fails:
 *
 *  1. EXACTNESS — strip those four from BOTH sides and demand the remainder
 *     deep-equal. Every other value the parser emits (token counts, costs,
 *     timestamps, message bodies, subagent identity and ordering) is thereby
 *     proven byte-identical to the frozen capture.
 *  2. ADDITIVE-ONLY — where the frozen oracle ALREADY carried one of the four
 *     (the Codex dossier carries `type`/`task`), the parsed value must be
 *     unchanged. Gate 1 alone would mask a regression there, since it strips
 *     the field from both sides; this gate closes that hole, so a proposal can
 *     only ever ADD.
 *
 * Usage:
 *   pnpm exec tsx test/golden/derive-iss4592-oracle-amendments.ts --output <dir>
 */
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  assertProposalOutputRoot,
  writeOracleProposal,
} from "./fea3419-oracle-output.js";
import {
  discoverDossiers,
  jsonNormalize,
  parseDossierRaw,
} from "./golden-corpus.js";

const outFlagIndex = process.argv.indexOf("--output");
const outArg = outFlagIndex >= 0 ? process.argv[outFlagIndex + 1] : undefined;
if (!outArg) {
  throw new Error(
    "usage: derive-iss4592-oracle-amendments.ts --output <dir> (must be OUTSIDE packages/golden-sessions)"
  );
}
const OUT_DIR = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);
const GOLDEN_CORPUS_DIR = fileURLToPath(
  new URL("../../../../packages/golden-sessions", import.meta.url)
);
assertProposalOutputRoot(OUT_DIR, GOLDEN_CORPUS_DIR);

type Rec = Record<string, unknown>;

/** The subagent-record fields ISS-4592 authorizes adding. */
const SUBAGENT_FIELDS = ["type", "task"] as const;
const METADATA_FIELDS = ["spawnedByToolUseId", "description"] as const;

const SUBAGENT_TRANSCRIPT_EXT = ".jsonl";
const SUBAGENT_META_EXT = ".meta.json";
const SUBAGENT_TRANSCRIPT_SUFFIX_RE = /\.jsonl$/;

/**
 * Strip the ISS-4592 delta from BOTH sides so the remainder must deep-equal.
 * An emptied `metadata` is dropped rather than left as `{}` — the frozen
 * sidecar records carry no `metadata` key at all, and a bare `{}` would read
 * as a difference the ticket did not authorize.
 */
function withoutIss4592Fields(value: Rec): Rec {
  const clone = JSON.parse(JSON.stringify(value)) as Rec;
  if (!Array.isArray(clone.subagents)) {
    return clone;
  }
  clone.subagents = (clone.subagents as Rec[]).map((subagent) => {
    const { type: _type, task: _task, metadata, ...rest } = subagent;
    if (metadata === undefined) {
      return rest;
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return { ...rest, metadata };
    }
    const {
      spawnedByToolUseId: _spawnedBy,
      description: _description,
      ...restMetadata
    } = metadata as Rec;
    return Object.keys(restMetadata).length === 0
      ? rest
      : { ...rest, metadata: restMetadata };
  });
  return clone;
}

function readField(subagent: Rec | undefined, field: string): unknown {
  return subagent?.[field];
}

function readMetadataField(subagent: Rec | undefined, field: string): unknown {
  const metadata = subagent?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  return (metadata as Rec)[field];
}

/**
 * Gate 2: a value the frozen oracle already carried must survive unchanged.
 * Returns a human-readable reason, or null when the proposal is additive.
 */
function findNonAdditiveChange(parsed: Rec, oracle: Rec): string | null {
  const parsedSubagents = Array.isArray(parsed.subagents)
    ? (parsed.subagents as Rec[])
    : [];
  const oracleSubagents = Array.isArray(oracle.subagents)
    ? (oracle.subagents as Rec[])
    : [];
  for (const [index, frozen] of oracleSubagents.entries()) {
    const candidate = parsedSubagents[index];
    for (const field of SUBAGENT_FIELDS) {
      const before = readField(frozen, field);
      if (before !== undefined && readField(candidate, field) !== before) {
        return `subagents[${index}].${field} changed (frozen value must survive)`;
      }
    }
    for (const field of METADATA_FIELDS) {
      const before = readMetadataField(frozen, field);
      if (
        before !== undefined &&
        readMetadataField(candidate, field) !== before
      ) {
        return `subagents[${index}].metadata.${field} changed (frozen value must survive)`;
      }
    }
  }
  return null;
}

/**
 * Gate 3: every ADDED value must be corroborated by the dossier's own raw
 * bytes, read here independently of the parser.
 *
 * Gates 1 and 2 are both blind to the added content: gate 1 strips the four
 * fields from both sides, and gate 2 only defends values the frozen oracle
 * already held — which, for the records this amendment changes, is none. So
 * without this gate a parser that swapped two same-type siblings' prompts (the
 * exact hazard ISS-4592 names) or invented a `type` wholesale would produce a
 * clean "0 failures" run. This closes that by re-deriving the delegation facts
 * straight from `raw/`, never from the parser's output.
 *
 * Corroboration sources, per subagent id `agent-<hex>`:
 *  - the sidecar `agent-<hex>.meta.json` (`agentType`, `description`, `toolUseId`)
 *  - any raw line whose `toolUseResult.agentId` is this child (`agentType`,
 *    `prompt`), joined to the `tool_use_id` its `message.content` answers
 *  - the delegating `Agent`/`Task` tool_use block itself, found by that id
 *    anywhere in the dossier's raw files (`subagent_type`, `prompt`,
 *    `description`)
 * A record with NO corroborating source is a failure: an added value must
 * always be traceable to something a human can open and read.
 */
type RawDelegationIndex = {
  /** delegating tool_use id -> the `input` object the raw bytes carry */
  kickoffByToolUseId: Map<string, Rec>;
  /** child subagent id -> the answering tool_result's payload facts */
  resultByAgentId: Map<string, Rec>;
};

/** Recursively list a dossier's raw transcript files. */
function collectRawTranscripts(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectRawTranscripts(full));
    } else if (entry.name.endsWith(SUBAGENT_TRANSCRIPT_EXT)) {
      files.push(full);
    }
  }
  return files;
}

function contentBlocksOf(entry: Rec): Rec[] {
  const message = entry.message;
  const content =
    message && typeof message === "object" ? (message as Rec).content : null;
  return Array.isArray(content) ? (content as Rec[]) : [];
}

function indexRawBlock(
  index: RawDelegationIndex,
  entry: Rec,
  block: Rec
): void {
  if (
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    (block.name === "Agent" || block.name === "Task")
  ) {
    index.kickoffByToolUseId.set(block.id, (block.input ?? {}) as Rec);
    return;
  }
  if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
    return;
  }
  const result = entry.toolUseResult;
  if (!result || typeof result !== "object") {
    return;
  }
  const payload = result as Rec;
  if (typeof payload.agentId === "string") {
    index.resultByAgentId.set(`agent-${payload.agentId}`, {
      toolUseId: block.tool_use_id,
      agentType: payload.agentType,
      prompt: payload.prompt,
    });
  }
}

/** Read the delegation facts out of raw bytes, independently of the parser. */
function indexRawDelegations(rawFiles: readonly string[]): RawDelegationIndex {
  const index: RawDelegationIndex = {
    kickoffByToolUseId: new Map(),
    resultByAgentId: new Map(),
  };
  for (const file of rawFiles) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      let entry: Rec;
      try {
        entry = JSON.parse(line) as Rec;
      } catch {
        continue;
      }
      for (const block of contentBlocksOf(entry)) {
        indexRawBlock(index, entry, block);
      }
    }
  }
  return index;
}

/** The sidecar's own `agent-<hex>.meta.json`, or null when absent/corrupt. */
function readRawSidecarMeta(
  rawFiles: readonly string[],
  subagentId: string
): Rec | null {
  const transcript = rawFiles.find((file) =>
    file.endsWith(`${subagentId}${SUBAGENT_TRANSCRIPT_EXT}`)
  );
  if (!transcript) {
    return null;
  }
  try {
    const meta = JSON.parse(
      readFileSync(
        transcript.replace(SUBAGENT_TRANSCRIPT_SUFFIX_RE, SUBAGENT_META_EXT),
        "utf8"
      )
    );
    return meta && typeof meta === "object" ? (meta as Rec) : null;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/** True when `candidate` equals one of the raw values, ignoring absent ones. */
function contradictsRaw(candidate: unknown, sources: unknown[]): boolean {
  const present = sources.filter((value) => value !== undefined);
  // `present` holds no `undefined` (just filtered out), so an `undefined`
  // candidate can never be one of them — short-circuiting on it is the exact
  // same answer `includes` would give, and it narrows `candidate` to the
  // element type the filtered array carries.
  return (
    present.length > 0 &&
    (candidate === undefined || !present.includes(candidate))
  );
}

/**
 * A stored text field is the raw value or a producer-truncated prefix of it —
 * never a different string.
 */
function isNoPrefixOf(candidate: string, sources: unknown[]): boolean {
  const present = sources.filter(
    (value): value is string => typeof value === "string"
  );
  return (
    present.length > 0 &&
    !present.some((source) => source.startsWith(candidate))
  );
}

/** Corroborate one subagent's added values; returns the violations found. */
function checkSubagentAgainstRaw(
  subagent: Rec,
  rawFiles: readonly string[],
  index: RawDelegationIndex
): string[] {
  const addedType = subagent.type;
  const addedTask = subagent.task;
  const addedSpawn = readMetadataField(subagent, "spawnedByToolUseId");
  const addedDescription = readMetadataField(subagent, "description");
  if (
    addedType === undefined &&
    addedTask === undefined &&
    addedSpawn === undefined &&
    addedDescription === undefined
  ) {
    return [];
  }
  const id = typeof subagent.id === "string" ? subagent.id : "";
  const meta = readRawSidecarMeta(rawFiles, id);
  const fromResult = index.resultByAgentId.get(id) ?? null;
  const spawnId = firstString(
    addedSpawn,
    meta?.toolUseId,
    fromResult?.toolUseId
  );
  const kickoff = spawnId
    ? (index.kickoffByToolUseId.get(spawnId) ?? null)
    : null;
  if (!(meta || fromResult || kickoff)) {
    return [`${id}: added values with NO corroborating raw source`];
  }

  const violations: string[] = [];
  if (
    addedSpawn !== undefined &&
    meta?.toolUseId !== addedSpawn &&
    fromResult?.toolUseId !== addedSpawn
  ) {
    violations.push(
      `${id}: spawnedByToolUseId ${String(addedSpawn)} appears in no raw source`
    );
  }
  if (
    addedType !== undefined &&
    contradictsRaw(addedType, [
      meta?.agentType,
      fromResult?.agentType,
      kickoff?.subagent_type,
      kickoff?.agent_type,
    ])
  ) {
    violations.push(`${id}: type ${String(addedType)} matches no raw source`);
  }
  if (
    typeof addedTask === "string" &&
    isNoPrefixOf(addedTask, [kickoff?.prompt, fromResult?.prompt])
  ) {
    violations.push(`${id}: task is not a prefix of any raw prompt`);
  }
  if (
    typeof addedDescription === "string" &&
    isNoPrefixOf(addedDescription, [meta?.description, kickoff?.description])
  ) {
    violations.push(`${id}: description matches no raw source`);
  }
  return violations;
}

function findRawViolations(dossierRawDir: string, proposal: Rec): string[] {
  const rawFiles = collectRawTranscripts(dossierRawDir);
  const index = indexRawDelegations(rawFiles);
  const subagents = Array.isArray(proposal.subagents)
    ? (proposal.subagents as Rec[])
    : [];
  return subagents.flatMap((subagent) =>
    checkSubagentAgainstRaw(subagent, rawFiles, index)
  );
}

/**
 * Re-serialize `parsed` using the FROZEN oracle's key order wherever a key
 * exists on both sides, appending genuinely-new keys last. Same rationale as
 * the FEA-3597 generator: the frozen captures carry pre-existing key-order
 * drift that `isDeepStrictEqual` cannot see, and bundling a repo-wide key
 * reshuffle into a signed-oracle amendment would swamp the reviewable delta.
 *
 * Values always come from `parsed`; this only reorders keys. Sound because the
 * gates above already proved the two sides agree outside the added fields.
 */
function withOracleKeyOrder(parsed: unknown, oracle: unknown): unknown {
  if (Array.isArray(parsed)) {
    const oracleItems = Array.isArray(oracle) ? oracle : [];
    return parsed.map((item, index) =>
      withOracleKeyOrder(item, oracleItems[index])
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    return parsed;
  }
  const parsedRec = parsed as Rec;
  const oracleRec =
    oracle !== null && typeof oracle === "object" && !Array.isArray(oracle)
      ? (oracle as Rec)
      : {};
  const out: Rec = {};
  for (const key of Object.keys(oracleRec)) {
    if (key in parsedRec) {
      out[key] = withOracleKeyOrder(parsedRec[key], oracleRec[key]);
    }
  }
  for (const key of Object.keys(parsedRec)) {
    if (!(key in out)) {
      out[key] = withOracleKeyOrder(parsedRec[key], undefined);
    }
  }
  return out;
}

/** Per-proposal reporting: how many subagents gained each field. */
function countEnriched(value: Rec): {
  subagents: number;
  type: number;
  task: number;
  spawn: number;
} {
  const subagents = Array.isArray(value.subagents)
    ? (value.subagents as Rec[])
    : [];
  return {
    subagents: subagents.length,
    type: subagents.filter((s) => s.type !== undefined).length,
    task: subagents.filter((s) => s.task !== undefined).length,
    spawn: subagents.filter(
      (s) => readMetadataField(s, "spawnedByToolUseId") !== undefined
    ).length,
  };
}

let proposals = 0;
let unchanged = 0;
let failures = 0;
for (const d of discoverDossiers()) {
  if (d.normalized === null) {
    unchanged += 1;
    continue;
  }
  const parsed = jsonNormalize(await parseDossierRaw(d));
  if (parsed === null) {
    failures += 1;
    console.error(`PARSER EMITTED NULL (manual review): ${d.sessionId}`);
    continue;
  }
  // Preserve the frozen capture-time mtime (jsonNormalize nulls it).
  parsed.fileModifiedAt = d.normalized.fileModifiedAt ?? null;
  // Preserve the oracle's `plans: []` spelling where it exists (FEA-3553):
  // jsonNormalize drops an empty plans array on the parse side, but a proposal
  // must not silently delete a key the frozen oracle carries.
  if (
    Array.isArray(d.normalized.plans) &&
    d.normalized.plans.length === 0 &&
    !("plans" in parsed)
  ) {
    parsed.plans = [];
  }

  // Gate 1 — exactness outside the authorized fields.
  if (
    !isDeepStrictEqual(
      withoutIss4592Fields(parsed),
      withoutIss4592Fields(d.normalized)
    )
  ) {
    failures += 1;
    console.error(
      `UNEXPECTED NON-ISS-4592 DIFFERENCE (manual review): ${d.sessionId}`
    );
    continue;
  }
  // Gate 2 — additive only.
  const nonAdditive = findNonAdditiveChange(parsed, d.normalized);
  if (nonAdditive) {
    failures += 1;
    console.error(
      `NON-ADDITIVE CHANGE (manual review): ${d.sessionId} — ${nonAdditive}`
    );
    continue;
  }
  if (isDeepStrictEqual(parsed, d.normalized)) {
    unchanged += 1;
    continue;
  }
  // Gate 3 — every added value is corroborated by the raw bytes.
  const rawViolations = findRawViolations(d.rawDir, parsed);
  if (rawViolations.length > 0) {
    failures += 1;
    console.error(
      `ADDED VALUES NOT SUPPORTED BY RAW (manual review): ${d.sessionId}\n  ${rawViolations.join("\n  ")}`
    );
    continue;
  }
  const ordered = withOracleKeyOrder(parsed, d.normalized) as Rec;
  if (!isDeepStrictEqual(ordered, parsed)) {
    failures += 1;
    console.error(`KEY-ORDER PASS ALTERED SEMANTICS (bug): ${d.sessionId}`);
    continue;
  }
  writeOracleProposal({
    outputRoot: OUT_DIR,
    corpusRoot: GOLDEN_CORPUS_DIR,
    sessionId: d.sessionId,
    contents: `${JSON.stringify(ordered, null, 2)}\n`,
  });
  const counts = countEnriched(ordered);
  console.log(
    `proposal: ${d.sessionId} — ${counts.subagents} subagent(s): ` +
      `type=${counts.type} task=${counts.task} spawnedBy=${counts.spawn}`
  );
  proposals += 1;
}

console.log(
  `\n${proposals} proposal(s), ${unchanged} unchanged, ${failures} failure(s)`
);
if (failures > 0) {
  console.error(
    "FAILURES PRESENT — no amendment may be applied from this run; investigate the parser."
  );
  process.exit(1);
}
