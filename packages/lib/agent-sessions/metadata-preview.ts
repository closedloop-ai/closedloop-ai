import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { isRecord } from "../harness/type-guards";
import { redactSecrets } from "../security/redact-secrets";
import {
  AGENT_TURN_TIMESTAMPS_METADATA_KEY,
  MAX_METADATA_AGENT_TURN_TIMESTAMPS,
} from "./agent-turn-timestamps";
import {
  HUMAN_TURN_TIMESTAMPS_METADATA_KEY,
  isHumanTurnTimestamp,
  MAX_METADATA_HUMAN_TURN_TIMESTAMPS,
} from "./human-turn-timestamps";

/**
 * FEA-3693: the ONE shared, version-skew-safe long-message transcript-preview
 * contract for persisted/synced session `metadata` blobs.
 *
 * Both the desktop sync producer (`compactSessionMetadataForSync` in
 * `apps/desktop/src/main/agent-sync/agent-session-sync-metadata.ts`) and the
 * cloud persist boundary (`sanitizeMetadataForPersist` in
 * `apps/api/app/agent-sessions/service/metadata-sanitizer.ts`) delegate here, so
 * the two lanes cannot drift: for the SAME normalized transcript input they emit
 * byte-identical `metadata` on every key EXCEPT
 * {@link HUMAN_TURN_TIMESTAMPS_METADATA_KEY} and
 * {@link AGENT_TURN_TIMESTAMPS_METADATA_KEY}. ISS-7896 made the first
 * asymmetric on purpose, and ISS-9864 the second on the same terms — the desktop
 * producer DERIVES each from the full local `messages` array before delegating,
 * and this module can only bound what it is given, never compute it, because
 * the cloud re-compacts an already-capped blob.
 * Every other key is still equal by construction. Before this module they were
 * hand-duplicated and had
 * contradictory long-message policies — desktop kept a per-message preview floor
 * after the aggregate byte budget while the cloud dropped later `text` entirely,
 * so session rows and detail disagreed on long conversations.
 *
 * This package is surface-agnostic and browser-safe (no Node built-ins, see
 * `@repo/lib` AGENTS.md): it is bundled into the Electron main process AND
 * resolved as source by `apps/api`, which is why the single policy can be shared
 * by construction.
 */

/** Max object-nesting depth retained; deeper objects collapse to `null`. */
export const MAX_METADATA_DEPTH = 4;
/** Max own-keys retained per object (extra keys dropped). */
export const MAX_METADATA_KEYS = 80;
/** Max items retained per array (extra items dropped). */
export const MAX_METADATA_ARRAY_ITEMS = 100;
/** Max chars retained for a generic (non-message-text) string field. */
export const MAX_METADATA_STRING_CHARS = 1024;
/** Max messages retained from `metadata.messages[]` (extra messages dropped). */
export const MAX_METADATA_MESSAGES = 100;
/**
 * Per-message text preview cap. The effective ceiling for how much human/
 * assistant turn text reaches the cloud DB and renders in the branch merged
 * trace / `SessionDetail.turnItems[].text`. Sized (Marisol, FEA-3672) as
 * `max(2500, golden-corpus p95 of 1361)`, bounded by the parser's 4096-byte
 * `truncateText` ceiling. Stays a sanitized preview — full text lives in the
 * FEA-2717 transcript archive.
 */
export const MAX_METADATA_MESSAGE_TEXT_CHARS = 2500;
/**
 * Aggregate cap on preview text summed across ALL messages in one session,
 * independent of the per-message cap. The full `metadata` blob is replicated
 * into every desktop sync chunk and measured against the 256 KiB payload cap;
 * 100 messages at the per-message cap (~250 KiB) would blow it and dead-letter
 * the session. This budget bounds the summed preview well under the payload cap.
 * Once exhausted, later messages fall back to the per-message FLOOR below (they
 * never drop `text` entirely).
 */
export const MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS = 60_000;
/**
 * Per-message FLOOR that survives the aggregate budget. Without it, once the
 * running budget is exhausted every later message drops `text` — regressing
 * those turns to no preview and hiding the most recent prompts in long sessions.
 * The old FEA-3033 value (160), chosen so the floor can never itself dead-letter
 * a session: worst case
 * `MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS + MAX_METADATA_MESSAGES × 160` ≈ 76 KiB
 * — comfortably under the 256 KiB payload cap.
 */
export const MIN_METADATA_MESSAGE_TEXT_CHARS = 160;
/** Keys stripped entirely from every metadata object. */
export const OMITTED_METADATA_KEYS: ReadonlySet<string> = new Set([
  "tokenSeries",
]);

/**
 * ISS-7775 — which class of `metadata` string a compaction may keep.
 *
 * `Retain` is the historical policy and is a DENY-LIST: it strips
 * {@link OMITTED_METADATA_KEYS}, bounds everything else, and passes the rest
 * through. That default is open by construction — a key nobody wrote a policy
 * for reaches the output as a bounded slice — which is exactly how prompt and
 * completion text kept egressing under a consent card that said it would not.
 *
 * `Omit` closes it, and closes it by INVERTING THE DEFAULT rather than by
 * lengthening a list of known-bad keys:
 *
 *   · `null` / `boolean` / `number` are kept unconditionally. None of them can
 *     carry a prompt, a completion, plan prose, or file contents, so the
 *     session-shape half of the blob (counts, timings, costs, diff stats,
 *     context windows, parse quality) survives untouched and needs no
 *     enumeration at all.
 *   · a STRING is DROPPED unless its COMPLETE PATH is in
 *     {@link STRUCTURAL_METADATA_STRING_PATHS}. Free-form text is the only shape
 *     that carries the content classes the consent card promises stay local, so
 *     denying it by default is what makes the retained set CLOSED: a key added
 *     to the blob tomorrow egresses nothing until someone states that its string
 *     is structural — and, because the match is on the path rather than the leaf
 *     name, a new nested shape cannot inherit an existing slot's permission by
 *     reusing its word.
 *
 * ISS-7896 added the ONE exception, and it closes over shape rather than over a
 * declared path: the entries of `metadata.humanTurnTimestamps` are retained
 * because each one VALIDATED as a timestamp (`isHumanTurnTimestamp`), not
 * because the path was declared structural. ISS-9864 gave
 * `metadata.agentTurnTimestamps` the same treatment under the same grammar. See
 * the second admission rule on {@link STRUCTURAL_METADATA_STRING_PATHS}. The set
 * above is therefore still closed — an undeclared key egresses nothing — but
 * "declared here" is no longer the only way in, so check
 * `compactTurnTimestamps` too before concluding a string cannot leave.
 *
 * The desktop producer selects the policy from the machine's data-sync level
 * (`dataSyncLevelToMetadataContentPolicy` in `apps/desktop/src/shared/`); the
 * cloud persist boundary has no user tier to read and keeps the default.
 */
export const MetadataContentPolicy = {
  Retain: "retain",
  Omit: "omit",
} as const;
export type MetadataContentPolicy =
  (typeof MetadataContentPolicy)[keyof typeof MetadataContentPolicy];

/**
 * ISS-7775 — the string-valued metadata slots {@link MetadataContentPolicy.Omit}
 * keeps, because their values are STRUCTURE (an enum, an identifier, a
 * timestamp, a reference) rather than something a human or an agent wrote in
 * prose.
 *
 * Matched on the COMPLETE PATH from the compacted blob's root, dot-joined, with
 * an array collapsed to its own key (`plans[].source` is `plans.source`) because
 * an element is judged under the array it came from. Nothing is matched on a
 * bare leaf name.
 *
 * PATHS, NOT LEAF KEYS, and that distinction is the whole guarantee (review:
 * whitlockk + the `security-privacy` critic, both on this PR). A leaf-key set cannot
 * express "this slot is structural" — only "this WORD is structural, wherever it
 * turns up". Generic words are exactly the ones a structural slot needs (`name`,
 * `source`, `role`, `model`), so a leaf-key set silently hands every one of them
 * to any nested shape that happens to reuse the word: `teams` and `compactions`
 * are `unknown[]` with no declared element shape, and a parser-supplied
 * `teams: [{ name: "<prompt prose>" }]` or an `agents[].metadata` of
 * `{ future: { name: "<prompt prose>" } }` inherited `name`'s permission and
 * egressed below Full. Under a path set those are `teams.name` and `future.name`
 * — undeclared, therefore denied — while `slashCommands.name` still resolves.
 * Unknown shapes are now denied by CONSTRUCTION rather than by being lucky
 * enough not to reuse an allow-listed word.
 *
 * ADMISSION RULE, so the next person adding a member has a test to apply rather
 * than a precedent to copy. A path belongs here only when BOTH hold: (a) its
 * value is structurally incapable of being prose — a closed enum, an identifier,
 * a timestamp, or the component NAME the consent card already syncs as
 * "Tool-call activity (names & counts)"; and (b) a consumer actually reads it,
 * or a ticket deliberately landed it to reach cloud sync. Slots that pass (a)
 * but fail (b) are LEFT OFF on purpose — `slashCommands[].definitionSnapshot`'s
 * `rawName`/`kind`/`capturedAt` and every `artifacts` reference have no reader
 * anywhere, so denying them costs no capability.
 *
 * SECOND ADMISSION RULE (ISS-7896), stated here because this is where a reader
 * looks to answer "may this string leave a Metadata-tier machine". A string may
 * ALSO be retained without appearing in this set when a key-specific compactor
 * admits it by VALIDATED SHAPE — today exactly one does,
 * `compactTurnTimestamps`, for the entries of
 * {@link HUMAN_TURN_TIMESTAMPS_METADATA_KEY} and (ISS-9864, same grammar, same
 * consumer surface) {@link AGENT_TURN_TIMESTAMPS_METADATA_KEY}. Shape admission
 * is narrower than a path entry, not a loophole around it: a path entry retains
 * whatever string happens to sit at that path, while shape admission retains
 * only values that match a grammar which cannot express prose. It was chosen
 * over adding a path here precisely BECAUSE a path entry matches on path alone
 * and would have also admitted a scalar `humanTurnTimestamps: "<prompt prose>"`.
 * A future key wanting the same treatment owes the same proof: a grammar that
 * structurally excludes free text, plus a named consumer that reads it.
 *
 * Conspicuously ABSENT, each deliberately: `text` (turn text), `content` (plan
 * prose AND slash-command definition file text), `claudeDesktopOrigin.title`
 * (annotated "FREE TEXT (user content)" at its declaration), `task`, `summary`,
 * `description`, `command`. Adding a member here widens what leaves a
 * Metadata-only machine — state why.
 */
export const STRUCTURAL_METADATA_STRING_PATHS: ReadonlySet<string> = new Set([
  // Session shape (`buildImportMetadata`): harness/schema version, session slug,
  // branch name, launch entrypoint, permission mode. `entrypoint` and
  // `permissionMode` are the only two the CLOUD itself reads today
  // (`apps/api/app/insights/lib/activity-heatmap.ts`).
  "version",
  "slug",
  "gitBranch",
  "entrypoint",
  "permissionMode",
  // `messages[]` shape — the turn's role, when it happened, and which model
  // answered, all read by `agent-session-detail-projection`. `messages.text` is
  // NOT here, which is the whole point: the turn still appears on the timeline
  // (the projection keeps any message carrying role + timestamp), carrying no
  // content. Scoped to the ROOT `messages` array; a nested `<unknown>.messages`
  // is an undeclared shape and is denied.
  "messages.role",
  "messages.timestamp",
  "messages.model",
  // Component identity: `slashCommands[].name` is the "Tool-call activity
  // (names & counts)" line, and the projection joins a command to its human turn
  // on `name` + `timestamp` + `userTurnId` + `normalizedName`.
  "slashCommands.name",
  "slashCommands.normalizedName",
  "slashCommands.userTurnId",
  "slashCommands.timestamp",
  "slashCommands.definitionSnapshot.normalizedName",
  // `plans[].source` is the extractor that found the plan ("ExitPlanMode"), read
  // beside the plan row. The plan's `content` is not retained.
  "plans.source",
  "plans.timestamp",
  // `usageExtras`: closed provider enums (service tier, speed, inference geo).
  "usageExtras.service_tiers",
  "usageExtras.speeds",
  "usageExtras.inference_geos",
  // `claudeDesktopOrigin` (ISS-7198) minus its FREE-TEXT `title` — the ids are
  // the launch linkage that ticket landed specifically to reach cloud sync.
  "claudeDesktopOrigin.sessionId",
  "claudeDesktopOrigin.scheduledTaskId",
  // `harnessLaunchAttribution` (ISS-7259/ISS-7508), every member read by
  // `session-launch-attribution-view`. `agentNickname` is human-chosen, so it is
  // the softest entry here; it is a bounded agent LABEL (capped at
  // `MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS`), not a turn, and the view renders it
  // as the agent's identity.
  "harnessLaunchAttribution.threadSource",
  "harnessLaunchAttribution.promptSource",
  "harnessLaunchAttribution.agentRole",
  "harnessLaunchAttribution.agentNickname",
  "harnessLaunchAttribution.firstAttributedSkill",
  "harnessLaunchAttribution.parentThreadId",
]);

/**
 * FEA-3693 truncation metadata attached to each compacted message so a UI can
 * truthfully distinguish previewed / omitted / complete content instead of
 * silently rendering a truncated slice as if it were the full turn. Emitted ONLY
 * for messages that carried `text`; absent text stays fully OMITTED (no `text`,
 * no `textTruncation`).
 *
 * - `complete`  — the full turn text was retained (no truncation applied).
 * - `previewed` — the stored `text` is a bounded slice; the full turn is longer
 *   and lives only in the transcript archive. Includes floor-clamped messages
 *   (aggregate budget exhausted) whose slice is shorter than the source.
 */
export type MetadataMessageTextTruncation = "complete" | "previewed";

export const METADATA_MESSAGE_TEXT_TRUNCATION_KEY = "textTruncation" as const;

/**
 * Reduce an arbitrary `metadata` blob to the bounded, content-stripped shape
 * both lanes are allowed to persist/sync. Returns `null` for non-objects and for
 * objects that compact to nothing. Deterministic and idempotent: a
 * already-compacted, already-capped blob is returned unchanged (aside from
 * re-derivable `textTruncation` markers).
 */
export function compactMetadataForPreview(
  metadata: unknown,
  // ISS-7775: DEFAULTS TO THE PERMISSIVE POLICY, deliberately. The cloud persist
  // boundary (`sanitizeMetadataForPersist`) is a defense-in-depth strip over a
  // payload that has ALREADY left some machine, and it has no user tier to read
  // — the batch's `dataSyncLevel` is self-reported by the client, so it is not a
  // boundary that can decide egress. Narrowing here unconditionally would delete
  // the turn previews of Full-tier users, whose consent card says that text
  // syncs. The DESKTOP producer is the seam that knows the tier, and it passes
  // the policy explicitly (`sanitizeSessionForSync`).
  contentPolicy: MetadataContentPolicy = MetadataContentPolicy.Retain
): JsonObject | null {
  return compactMetadataFromRoot(metadata, contentPolicy, "");
}

/**
 * ISS-7775 (review: davetho) — the path prefix every `agents[].metadata` string
 * is judged under, so that blob CANNOT resolve against a session slot.
 *
 * No member of {@link STRUCTURAL_METADATA_STRING_PATHS} lies beneath it, and that
 * is the entire point: prefixing is a pure DENIAL, never a grant. It cannot widen
 * what leaves a machine no matter which prefix is chosen, because a prefixed path
 * can only fail a lookup the unprefixed one might have passed.
 */
export const AGENT_METADATA_PATH_ROOT = "agents.metadata";

/**
 * ISS-7775 (review: davetho) — {@link compactMetadataForPreview} for an
 * `agents[].metadata` blob, whose keys are NAMESPACED before they are judged.
 *
 * `agents[].metadata` is compacted as its OWN root, so under a session-rooted
 * path set an agent inherited a session slot's permission by naming its root key
 * `gitBranch`, `slug`, `version`, `entrypoint`, `permissionMode` or `messages`.
 * That is borrow-by-collision — the defect the path set replaced the leaf-key set
 * to close — one container down, and it is reachable rather than theoretical:
 * `buildSubagentMetadata` spreads the PARSER's own keys into this blob, so the
 * colliding word is supplied by the same untrusted source the allow-list exists
 * to bound.
 *
 * Prefixing makes every agent-metadata string an undeclared path, so below `full`
 * none of them egress — by construction, rather than by nobody having yet picked
 * a colliding word. The blob's numbers, booleans and nulls are untouched, so the
 * agent's session-shape metadata still syncs; only its free-form strings stop.
 */
export function compactAgentMetadataForPreview(
  metadata: unknown,
  contentPolicy: MetadataContentPolicy = MetadataContentPolicy.Retain
): JsonObject | null {
  return compactMetadataFromRoot(
    metadata,
    contentPolicy,
    AGENT_METADATA_PATH_ROOT
  );
}

function compactMetadataFromRoot(
  metadata: unknown,
  contentPolicy: MetadataContentPolicy,
  rootPath: string
): JsonObject | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const compacted = compactMetadataObject(metadata, 0, contentPolicy, rootPath);
  return compacted && Object.keys(compacted).length > 0 ? compacted : null;
}

/**
 * ISS-7775: the dot-joined path of `key` beneath `parentPath`, which is what
 * {@link STRUCTURAL_METADATA_STRING_PATHS} is keyed on. `""` is the SESSION
 * blob's root; `agents[].metadata` is compacted as its own root under
 * {@link AGENT_METADATA_PATH_ROOT} instead, which is what keeps the two
 * containers' paths from colliding.
 */
function childPath(parentPath: string, key: string): string {
  return parentPath ? `${parentPath}.${key}` : key;
}

function compactMetadataObject(
  metadata: Record<string, unknown>,
  depth: number,
  contentPolicy: MetadataContentPolicy,
  parentPath: string
): JsonObject | null {
  if (depth > MAX_METADATA_DEPTH) {
    return null;
  }
  // ISS-8565: null-prototype container so a key literally named `__proto__`
  // (which `JSON.parse` DOES create as a real own key) becomes an own property
  // instead of hitting the inherited `__proto__` setter. Losing it here is
  // worse than one dropped field: the `length > 0` collapse below would then
  // turn a metadata object whose only key was `__proto__` into `null`, deleting
  // the entire preview rather than a single entry.
  const compacted: JsonObject = Object.create(null);
  for (const [key, value] of Object.entries(metadata).slice(
    0,
    MAX_METADATA_KEYS
  )) {
    if (OMITTED_METADATA_KEYS.has(key)) {
      continue;
    }
    const path = childPath(parentPath, key);
    const compactValue = compactMetadataEntry(
      key,
      value,
      depth,
      path,
      contentPolicy
    );
    if (compactValue !== undefined) {
      compacted[key] = compactValue;
    }
  }
  // Spread restores a normal prototype for downstream consumers (object spread
  // defines rather than assigns, so an own `__proto__` key survives the copy).
  return Object.keys(compacted).length > 0 ? { ...compacted } : null;
}

function compactMetadataMessages(
  value: unknown,
  contentPolicy: MetadataContentPolicy,
  path: string
): JsonValue {
  if (!Array.isArray(value)) {
    return compactMetadataValue(value, 1, path, contentPolicy) ?? null;
  }
  // Running budget for preview text summed across all messages, so a long
  // conversation of near-cap turns cannot bloat metadata past the payload byte
  // cap and dead-letter the whole session. Per-message cap still applies; this
  // only bounds the AGGREGATE. Once exhausted, messages fall back to the
  // per-message FLOOR (never dropping `text` entirely) — the single policy both
  // lanes now share (FEA-3693).
  let remainingTextChars = MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS;
  return value.slice(0, MAX_METADATA_MESSAGES).map((item) => {
    if (!isRecord(item)) {
      return null;
    }
    const compacted: JsonObject = {};
    copyStringMetadata(item, compacted, "role", contentPolicy, path);
    copyStringMetadata(item, compacted, "timestamp", contentPolicy, path);
    copyStringMetadata(item, compacted, "model", contentPolicy, path);
    // ISS-7775: `text` IS the "Prompts & completions" channel, so under `Omit`
    // the message keeps its shape (role, timestamp, model, flags) and carries no
    // turn text — and no `textTruncation` marker either, matching the existing
    // rule that a message without stored text is fully omitted rather than
    // marked. The aggregate budget is untouched because nothing debits it.
    if (contentPolicy === MetadataContentPolicy.Retain) {
      const perMessageTextCap = Math.min(
        MAX_METADATA_MESSAGE_TEXT_CHARS,
        Math.max(remainingTextChars, MIN_METADATA_MESSAGE_TEXT_CHARS)
      );
      if (perMessageTextCap > 0) {
        remainingTextChars -= copyRedactedText(
          item,
          compacted,
          perMessageTextCap
        );
      }
    }
    copyBooleanMetadata(item, compacted, "isThinking");
    copyBooleanMetadata(item, compacted, "isSynthetic");
    // ISS-8659: this is an ALLOW-LIST rebuild, not a filter — a key absent from
    // it cannot reach the cloud at all. `isForkReplayed` is what tells the cloud
    // heatmap which of a `/fork` child's rendered turns are the parent's, so
    // omitting it here does not degrade that gate, it makes it unmatchable. The
    // ISS-7775 content rule is satisfied by construction: `copyBooleanMetadata`
    // never consults the path allow-list, and a boolean carries no prose.
    copyBooleanMetadata(item, compacted, "isForkReplayed");
    return compacted;
  });
}

function compactMetadataValue(
  value: unknown,
  depth: number,
  path: string,
  contentPolicy: MetadataContentPolicy
): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return retainedString(value, path, contentPolicy);
  }
  if (Array.isArray(value)) {
    if (depth > MAX_METADATA_DEPTH) {
      return [];
    }
    // Array elements are judged under the ARRAY's own path: a bare string in
    // `teams[]` is `teams`, so an opaque list of prose cannot slip through by
    // having no key of its own.
    return value
      .slice(0, MAX_METADATA_ARRAY_ITEMS)
      .map(
        (item) =>
          compactMetadataValue(item, depth + 1, path, contentPolicy) ?? null
      );
  }
  if (isRecord(value)) {
    return compactMetadataObject(value, depth, contentPolicy, path);
  }
  return undefined;
}

function copyStringMetadata(
  source: Record<string, unknown>,
  target: JsonObject,
  key: string,
  contentPolicy: MetadataContentPolicy,
  parentPath: string
): void {
  const value = source[key];
  if (typeof value !== "string") {
    return;
  }
  const retained = retainedString(
    value,
    childPath(parentPath, key),
    contentPolicy
  );
  if (retained !== undefined) {
    target[key] = retained;
  }
}

function copyBooleanMetadata(
  source: Record<string, unknown>,
  target: JsonObject,
  key: string
): void {
  const value = source[key];
  if (typeof value === "boolean") {
    target[key] = value;
  }
}

/**
 * FEAT 019f881c: copy the message `text` preview with pattern-based secret
 * redaction applied via the shared `@repo/lib/security/redact-secrets` SSOT.
 * Redaction runs BEFORE the length cap so a secret at the truncation boundary
 * can never leave a partial-key fragment in the stored/synced preview.
 *
 * FEA-3693: also stamps `textTruncation` so the UI can distinguish a full turn
 * from a bounded preview. Absent/non-string source `text` is left OMITTED (no
 * `text`, no marker). Returns the number of stored `text` chars so the caller
 * can debit the aggregate budget.
 *
 * ISS-8014: this used to be the ONLY route to `redactSecrets` in this module, so
 * a credential in `messages[].text` was masked while the identical string in any
 * other metadata key reached the sink intact. Redaction now happens in
 * {@link redactedAndTruncated}, which every retained string goes through; this
 * function keeps only the per-message CAP and the truncation marker.
 */
function copyRedactedText(
  source: Record<string, unknown>,
  target: JsonObject,
  maxChars: number
): number {
  const value = source.text;
  if (typeof value !== "string") {
    return 0;
  }
  const redacted = redactSecrets(value);
  const stored = truncateString(redacted, maxChars);
  target.text = stored;
  const wasAlreadyPreviewed =
    source[METADATA_MESSAGE_TEXT_TRUNCATION_KEY] === "previewed";
  const truncation: MetadataMessageTextTruncation =
    stored.length < redacted.length || wasAlreadyPreviewed
      ? "previewed"
      : "complete";
  target[METADATA_MESSAGE_TEXT_TRUNCATION_KEY] = truncation;
  return stored.length;
}

function truncateString(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/**
 * The gate every non-message string passes on its way into a compacted blob,
 * unless a key-specific compactor admits it by validated shape.
 *
 * ISS-7896 introduced the one such compactor, `compactTurnTimestamps`, so
 * this is no longer the SOLE gate for array entries — see the second admission
 * rule on {@link STRUCTURAL_METADATA_STRING_PATHS}. `compactMetadataMessages` is
 * NOT a second exception: it special-cases the container, but every leaf it
 * keeps still routes back through here via `copyStringMetadata`. For everything
 * else, the two rules below still cannot be reached around.
 *
 * ISS-7775 — `undefined` (the key is dropped entirely, not emptied) whenever
 * `contentPolicy` is {@link MetadataContentPolicy.Omit} and `path` is not in
 * {@link STRUCTURAL_METADATA_STRING_PATHS}. Deny-by-default on the one value
 * shape that can carry a prompt, a completion, plan prose, or file contents.
 * `path` is the COMPLETE path from the compacted blob's root, so an undeclared
 * shape cannot borrow permission by reusing an allow-listed word for its leaf.
 *
 * ISS-8014 — otherwise the value is REDACTED and then capped. Redaction is here
 * rather than at a per-channel call site because the retained key set is open
 * under `Retain`: enumerating the channels that need masking is the same defect
 * this function exists to close, one level up.
 */
function retainedString(
  value: string,
  path: string,
  contentPolicy: MetadataContentPolicy
): string | undefined {
  if (
    contentPolicy === MetadataContentPolicy.Omit &&
    !STRUCTURAL_METADATA_STRING_PATHS.has(path)
  ) {
    return undefined;
  }
  return redactedAndTruncated(value, MAX_METADATA_STRING_CHARS);
}

/**
 * ISS-8014 — redact recognizable secrets, THEN cap, so a secret straddling the
 * truncation boundary can never leave a partial-key fragment behind.
 *
 * SINK: the compacted `metadata` blob only — what the desktop sync producer puts
 * on the wire and what the cloud persists. It does NOT reach the sources that
 * blob is derived from: the harness transcript files on local disk and the
 * desktop SQLite `event` rows still hold whatever the agent wrote. A clean
 * result here means this sink is clean, not that the credential was never
 * captured. A marker appears only when `redactSecrets` actually matched
 * non-empty sensitive content; a clean string is returned byte-identical.
 */
function redactedAndTruncated(value: string, maxChars: number): string {
  return truncateString(redactSecrets(value), maxChars);
}

/**
 * Route one own-key to its compaction policy. Extracted from
 * {@link compactMetadataObject} when ISS-7896 added a second special-cased key,
 * because the repo forbids a nested ternary.
 *
 * `messages` matches on the BARE KEY (its historical FEA-3693 behavior);
 * `humanTurnTimestamps` and `agentTurnTimestamps` match on the COMPLETE PATH,
 * so they fire only at the session root. That asymmetry is deliberate, not an
 * oversight to be tidied away: `agents[].metadata` is compacted as its own root
 * under {@link AGENT_METADATA_PATH_ROOT}, and a bare-key match would let a
 * parser-supplied agent blob claim a key's wider bound by reusing its name —
 * the borrow-by-collision defect the ISS-7775 path set exists to prevent.
 *
 * That guarantee is DESKTOP-ONLY, and the asymmetry is worth stating because the
 * sentence above reads as absolute. The cloud persist boundary compacts agent
 * metadata through `sanitizeMetadataForPersist` -> {@link
 * compactMetadataForPreview} at the SESSION root
 * (`apps/api/app/agent-sessions/service/session-slice-detail-write.ts`), not
 * through
 * {@link compactAgentMetadataForPreview}, so there a parser-supplied
 * `agents[].metadata.humanTurnTimestamps` DOES resolve to the session path and
 * take this bound. Accepted rather than fixed: <=1000 grammar-validated
 * timestamps is narrower in content and smaller in bytes than the generic
 * 100 x {@link MAX_METADATA_STRING_CHARS} cap it displaces, that boundary always
 * runs {@link MetadataContentPolicy.Retain}, and no consumer reads the key off an
 * agent blob.
 */
function compactMetadataEntry(
  key: string,
  value: unknown,
  depth: number,
  path: string,
  contentPolicy: MetadataContentPolicy
): JsonValue | undefined {
  if (key === "messages") {
    return compactMetadataMessages(value, contentPolicy, path);
  }
  if (path === HUMAN_TURN_TIMESTAMPS_METADATA_KEY) {
    return compactTurnTimestamps(
      value,
      depth,
      path,
      contentPolicy,
      MAX_METADATA_HUMAN_TURN_TIMESTAMPS
    );
  }
  if (path === AGENT_TURN_TIMESTAMPS_METADATA_KEY) {
    return compactTurnTimestamps(
      value,
      depth,
      path,
      contentPolicy,
      MAX_METADATA_AGENT_TURN_TIMESTAMPS
    );
  }
  return compactMetadataValue(value, depth + 1, path, contentPolicy);
}

/**
 * ISS-7896 — the bounded pass-through for `metadata.humanTurnTimestamps`, and
 * (ISS-9864) for `metadata.agentTurnTimestamps` under its own `maxEntries`.
 * One implementation for both keys: they share a grammar and a reader contract,
 * and only the bound is a per-key fact — passed in rather than read from one
 * key's constant, so a later re-ruling of either bound cannot leave the other
 * key silently on the wrong one.
 *
 * WHOLE OR ABSENT. Every entry must validate as a timestamp and the count must
 * fit the cap, or the key is dropped entirely. It never truncates and never
 * drops an individual entry, because the cloud reader takes a present array as
 * AUTHORITATIVE over `$.messages`: a partially-kept array would report fewer
 * turns than the path it displaces, which is the very undercount ISS-7896 and
 * ISS-9864 remove. Dropping the key leaves that reader on its existing basis
 * instead.
 *
 * This NEVER derives. The cloud persist boundary re-runs this compaction over an
 * already-compacted blob whose `messages` is capped at
 * {@link MAX_METADATA_MESSAGES}, so recomputing here would rebuild the key from
 * the truncated array and silently restore the bug. The desktop producer
 * (`agent-session-sync-metadata.ts`) is the only writer.
 *
 * A NON-array value falls through to {@link compactMetadataValue}, so it is
 * judged by {@link retainedString} exactly as before — which is what keeps a
 * scalar `humanTurnTimestamps: "<prose>"` denied under
 * {@link MetadataContentPolicy.Omit} and keeps a blob that does not carry this
 * key byte-identical to its pre-ISS-7896 output.
 *
 * Entries are NOT passed through `redactSecrets`. Every family in
 * `@repo/lib/security/redact-secrets` needs a literal prefix, a PEM header, an
 * `Authorization`/`Bearer` token, or URL userinfo — none of which the timestamp
 * grammar can produce — so redaction is a provable no-op here rather than a
 * skipped safeguard, and `metadata-preview.test.ts` pins that.
 */
function compactTurnTimestamps(
  value: unknown,
  depth: number,
  path: string,
  contentPolicy: MetadataContentPolicy,
  maxEntries: number
): JsonValue | undefined {
  if (!Array.isArray(value)) {
    return compactMetadataValue(value, depth + 1, path, contentPolicy);
  }
  if (value.length > maxEntries) {
    return undefined;
  }
  const entries: JsonValue[] = [];
  for (const item of value) {
    if (!isHumanTurnTimestamp(item)) {
      return undefined;
    }
    entries.push(item);
  }
  return entries;
}
