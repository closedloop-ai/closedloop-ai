import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { DATA_SYNC_LEVEL_COPY } from "@repo/app/shared/lib/data-sync-copy";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import { sanitizeSessionForSync } from "../../../../main/agent-sync/agent-session-sync-payload";
import { DESKTOP_AGENT_STATUS } from "../../../../main/database/db-constants";
import {
  dataSyncLevelToBooleans,
  dataSyncLevelToMetadataContentPolicy,
} from "../../../../shared/data-sync-level";
import {
  SYNC_LANE_IDS,
  SyncLaneId,
} from "../../../../shared/sync-burndown-contract";
import {
  buildEgressProbeSession,
  EGRESS_PROBE_SENTINELS,
} from "./data-sync-egress-probe";
import {
  observeAgentComponentInvocationSyncBatchKeys,
  observeAgentSessionSyncBatchKeys,
  observeDesktopAgentComponentsPayloadKeys,
} from "./sync-egress-envelope-capture";

// The per-level copy (`@repo/app/shared/lib/data-sync-copy`) tells the user what
// leaves this machine; `dataSyncLevelToBooleans` and the sync producer decide
// what actually does. They have separate owners on purpose — one is
// presentation, one is the egress derivation — so nothing but a test stops the
// labels from claiming more, or less, than the level performs. This is the
// renderer suite because it is the only one that can import both: the desktop
// `node:test` slice cannot load the TSX-adjacent copy module.
//
// Not a parity test between two components (ISS-6147 deleted the duplicate
// component that needed one). This pins copy against RUNTIME BEHAVIOR, which is
// the "never let the UI lie about what leaves the device" rule.
//
// ══ WHAT THIS FILE ACTUALLY PINS, AND WHAT IT DOES NOT (ISS-7769) ══
//
// TWO pins, at the only two granularities the code actually exposes:
//
//  1. CONTENT CLASSES, against the real producer at RUNTIME. A sentinel per
//     class is planted in a probe session, the production
//     `sanitizeSessionForSync` runs, and whichever sentinels survive onto the
//     wire ARE the egressed set. Making a class start egressing without
//     flipping its copy line fails `derives every per-level synced line from
//     the real sync producer`.
//
//  2. THE WIRE ENVELOPES, as SERIALIZED, unioned with what they declare. Every
//     field must be accounted for; a new one fails until someone says what the
//     consent card owes it.
//
//     OBSERVED is the authority. `sync-egress-envelope-capture.ts` drives each
//     lane's real production client with an injected `fetch` and reads the top-
//     level keys off the body it hands the network. This half exists because
//     TypeScript checks ASSIGNABILITY, not the absence of extra properties: its
//     excess-property check fires only on a fresh literal assigned to an
//     annotated target, so a spread-built envelope can carry keys its type never
//     mentions and still compile. That is not hypothetical —
//     `desktop-components-client.ts` re-envelopes every chunk as
//     `{ ...payload, componentCount, components }`. A field smuggled in that way
//     passes all five desktop typecheck projects and is caught only here.
//
//     DECLARED still runs alongside it, read from the AST of
//     `AgentSessionSyncBatch`, `AgentComponentInvocationSyncBatch` and
//     `DesktopAgentComponentsPayload`, because observation has the mirror-image
//     blind spot: an OPTIONAL field the probe does not populate (`encoding`,
//     `wantsAcceptedSessionIds`) appears in no captured body, and dropping the
//     AST read would quietly retire it from the audit. Neither source alone is
//     the wire; the union is.
//
//     WHICH ENVELOPES, and why it is a `Record` and not a list. This pin used to
//     be an ARRAY of two entries whose comment claimed it covered every envelope
//     the desktop POSTs. It did not — the invocation-parts lane was simply
//     missing, and a list cannot notice its own gaps, so the claim was worth
//     exactly as much as the last person's memory. `SYNC_LANE_EGRESS` is now a
//     `Record<SyncLaneId, …>` over the canonical lane union, so a new
//     lane fails `tsc` here until someone states what it puts on the wire.
//     Two of the lanes carry no declared envelope type; they are recorded AS
//     THAT, with the reason, because "nothing to enumerate" and "nobody looked"
//     must not look alike.
//
// What NEITHER pin covers, stated plainly so this header does not overclaim a
// second time:
//   · Session-row FIELDS. `sanitizeSessionForSync` spreads `...session`, so the
//     key set is whatever the SQLite hydrator (`assembleSyncedSessions`, not
//     exported) emitted. The test supplies that input, so the test cannot
//     observe it changing. A new session-row field slips past unless it carries
//     one of the four content classes.
//   · Inside the `metadata` blob — an opaque `JsonObject` the cloud accepts via
//     `z.unknown().pipe(jsonObjectSchema)`. A field-level guard sees one key,
//     `metadata`, and learns nothing about the content within. This is why
//     pin 1 probes CONTENT rather than fields: it is the only instrument that
//     sees into the blob at all.
//   · The component-inventory and invocation-parts lanes' BODIES. They ship
//     `SyncedComponent.content` and `AgentComponentInvocationSyncItem
//     .definitionContent` — definition FILE TEXT — on a gate that is open at the
//     `metadata` tier. Pin 2 now runs both lanes, but only to enumerate their
//     TOP-LEVEL envelope keys; it never inspects a component row, and pin 1
//     never runs either lane at all. So `PARTIALLY_OBSERVED_CLASSES` still stops
//     the file certifying "Tool inputs & file contents" as local. Whether that
//     text needs a consent line of its own is ISS-7777.
//   · The Full tier's delta — secret-redacted transcript JSONL on a separate
//     lane (`transcript-sync/`), which has no field set even in principle. Pin 1
//     models it as "every class"; unlike the metadata preview, nothing there
//     truncates or previews the turn/tool content.
// Closing the session-row gap needs a producer-side field projection that does
// not exist today.
//
// The prior version of this header claimed the whole file pinned copy against
// runtime. Only the content-class assertions did; the per-level synced list was
// `toEqual([…literal])` — copy-vs-constant, which stayed green when PR #5737
// added a field to what leaves the device. Those literals are kept below (they
// usefully pin copy STABILITY) but they are not the egress pin.
//
// ISS-7775 CLOSED THE METADATA HALF OF THIS, AND CHANGED WHAT PIN 1 MEASURES.
// `sanitizeSessionForSync` now takes the metadata content policy the machine's
// data-sync level derives, so the probe is run PER LEVEL rather than once: at
// `full` the blob still carries bounded turn/plan/definition previews, and at
// `metadata` / `redacted` it carries none, which is what the consent card has
// always said. `metadata` is no longer a deny-list there — a string survives
// only where its complete PATH is declared structural — so the channel list
// below can finally be a set someone is able to finish, and five of its six
// entries are gone.
//
// TWO channels still leak a class the copy calls local, and each is excused per
// CHANNEL (never per class, so a clean channel in the same class stays fully
// guarded) with its still-leaking assertion beside it: `agents[].name` and
// `session.name`. NEITHER is in `metadata` — both are wire ROW fields no content
// policy can reach — and closing either means deciding what the cloud UI shows
// instead of a name. See `KNOWN_UNRECONCILED_EGRESS`.
//
// The per-LEVEL policy itself — what each tier may put on the wire, that the
// retained set is closed by construction rather than by enumeration, and that
// every retained string is secret-redacted — is pinned by its sibling
// `data-sync-tier-egress.test.ts`, which probes the same session through the
// same shared fixture (`./data-sync-egress-probe`).

// A synced CONTENT line claims that a class of session *content* (tool
// inputs/outputs, file contents, prompts, completions, or full transcripts)
// leaves the device — as opposed to session-shape metadata (timing, cost,
// tool-call names/counts), which the metadata lane legitimately syncs. Content
// only leaves when the transcript lane is on.
const SYNCED_CONTENT_LABEL_RE =
  /tool inputs|file contents|prompts|completions|transcript/i;
const METADATA_ONLY_CAVEAT_RE = /metadata only/i;

describe("data-sync copy honesty about egress", () => {
  it("has copy for every level and no orphan keys", () => {
    for (const level of DATA_SYNC_LEVELS) {
      expect(DATA_SYNC_LEVEL_COPY[level]).toBeDefined();
    }
    expect(Object.keys(DATA_SYNC_LEVEL_COPY).toSorted()).toEqual(
      [...DATA_SYNC_LEVELS].toSorted()
    );
  });

  // NOTE (ISS-7775): this encodes "content only ever leaves via the transcript
  // lane", which the `metadata` blob already falsifies. It is a statement of the
  // INTENDED invariant, not of current behavior — so if ISS-7775 is resolved by
  // amending the copy rather than closing the leak, this test fails on the newly
  // HONEST copy and must be revisited with it.
  it("never advertises synced session content while the transcript lane is off", () => {
    for (const level of DATA_SYNC_LEVELS) {
      const booleans = dataSyncLevelToBooleans(level);
      const hasSyncedContentLine = DATA_SYNC_LEVEL_COPY[level].dataLines.some(
        (line) =>
          line.kind === "sync" && SYNCED_CONTENT_LABEL_RE.test(line.label)
      );
      if (!booleans.transcriptSyncEnabled) {
        expect(
          hasSyncedContentLine,
          `${level} must not advertise synced session content while transcriptSyncEnabled is false`
        ).toBe(false);
      }
    }
  });

  it("marks every line synced only when the level actually syncs (Off = all local)", () => {
    const offLines = DATA_SYNC_LEVEL_COPY[DataSyncLevel.Off].dataLines;
    expect(offLines.every((line) => line.kind === "local")).toBe(true);

    const fullLines = DATA_SYNC_LEVEL_COPY[DataSyncLevel.Full].dataLines;
    expect(fullLines.every((line) => line.kind === "sync")).toBe(true);
  });

  // ISS-7769: the next two `toEqual([…literal])` assertions pin copy STABILITY,
  // not egress — they compare copy to a constant, so they cannot notice a field
  // that starts leaving the device. Kept because an accidental copy edit should
  // still fail something. The egress pin is the probe-driven test after them.
  it("metadata syncs session-shape + tool-call activity but keeps content local", () => {
    const metadata = DATA_SYNC_LEVEL_COPY[DataSyncLevel.Metadata].dataLines;
    const synced = metadata
      .filter((line) => line.kind === "sync")
      .map((line) => line.label);
    const local = metadata
      .filter((line) => line.kind === "local")
      .map((line) => line.label);
    // Tool-call activity (eventType/toolName per-event rows) DOES leave in the
    // metadata lane; tool inputs/file contents and prompts/completions do NOT.
    expect(synced).toEqual([
      "Session shape, timing & cost",
      "Tool-call activity (names & counts)",
    ]);
    expect(local).toEqual([
      "Tool inputs & file contents",
      "Prompts & completions",
    ]);
  });

  it("Redacted advertises metadata-only egress today and flags redaction as forthcoming", () => {
    const redacted = DATA_SYNC_LEVEL_COPY[DataSyncLevel.Redacted];
    const syncedLabels = redacted.dataLines
      .filter((line) => line.kind === "sync")
      .map((line) => line.label);
    // The redaction lane is not plumbed, so redacted must sync no more than
    // metadata does today.
    expect(syncedLabels).toEqual([
      "Session shape, timing & cost",
      "Tool-call activity (names & counts)",
    ]);
    expect(
      redacted.caveat && METADATA_ONLY_CAVEAT_RE.test(redacted.caveat)
    ).toBeTruthy();
  });

  // ── The egress pin (ISS-7769) ──────────────────────────────────────────────

  it("plants every content class in the probe session before the producer runs", () => {
    // Anti-vacuity guard. Every "stays local" assertion below is satisfied by a
    // sentinel that is ABSENT from the wire — so a probe that never planted the
    // sentinel in the first place would make all of them pass while testing
    // nothing. This fails when the fixture drifts out of the real session shape.
    const planted = JSON.stringify(buildEgressProbeSession());
    for (const [label, sentinels] of Object.entries(EGRESS_PROBE_SENTINELS)) {
      for (const sentinel of sentinels) {
        expect(
          planted.includes(sentinel),
          `probe session never planted "${sentinel}" for the "${label}" line, so its egress is untestable`
        ).toBe(true);
      }
    }
  });

  it("builds the probe from vocabularies the hydrator can actually emit", () => {
    // whitlockk review: the probe's whole standing is its claim to be shaped like
    // what the SQLite hydrator hands the producer. Both status fields are typed
    // bare `string` (`SyncedAgentSession.status`,
    // `SyncedAgentSessionAgent.status`), so nothing in the type system stops a
    // fixture being assembled out of a vocabulary production never writes — and
    // then every egress assertion below describes a shape the cloud never
    // receives. The agent row is the trap: `sync-source.ts` copies
    // `agentRow.status` verbatim off the `agents` table, whose axis is
    // `DESKTOP_AGENT_STATUS`, NOT the session lifecycle set.
    const probe = buildEgressProbeSession();
    expect(
      Object.values(SESSION_STATUS),
      `probe session status "${probe.status}" is not a SESSION_STATUS lifecycle value`
    ).toContain(probe.status);
    for (const agent of probe.agents) {
      expect(
        Object.values(DESKTOP_AGENT_STATUS),
        `probe agent "${agent.externalAgentId}" carries status "${agent.status}", which the agents table cannot hold — the agent axis is DESKTOP_AGENT_STATUS, not the session lifecycle set`
      ).toContain(agent.status);
    }
  });

  it("has a probe for every content class the copy names, and no orphans", () => {
    const copyLabels = new Set(
      DATA_SYNC_LEVELS.flatMap((level) =>
        DATA_SYNC_LEVEL_COPY[level].dataLines.map((line) => line.label)
      )
    );
    // A copy line with no probe cannot be checked against egress, and a probe
    // with no copy line is dead weight. Adding either alone fails here.
    expect(Object.keys(EGRESS_PROBE_SENTINELS).toSorted()).toEqual(
      [...copyLabels].toSorted()
    );
  });

  it("detects real egress — the producer does ship the classes the copy calls synced", () => {
    // POSITIVE SIBLING for the derivation the negative assertions rely on. If
    // `classesSurvivingSyncProducer()` returned an empty set (broken import,
    // throwing producer, sentinels that never survive anything), every "stays
    // local" expectation would pass vacuously. This proves the probe observes
    // egress actually happening.
    const surviving = classesSurvivingSyncProducer(DataSyncLevel.Metadata);
    expect(surviving.has("Session shape, timing & cost")).toBe(true);
    expect(surviving.has("Tool-call activity (names & counts)")).toBe(true);
    // And it proves the probe can observe a class NOT egressing, so a green
    // result is a real discrimination and not a set that contains everything.
    expect(surviving.has("Tool inputs & file contents")).toBe(false);
  });

  it("keeps tool inputs and prompts out of the synced event row", () => {
    // Structural companion to the sentinel probe, which decides survival by
    // substring identity and so reads a TRUNCATED or REDACTED-but-present value
    // as absent. These two keys are the event row's content channels; asserting
    // their absence is exact and survives any transform, so a producer that
    // ships a shortened tool input cannot look local here.
    // At the WIDEST level, so the absence asserted below is the FEA-2718 event
    // projection doing it and not the metadata tier policy.
    const [event] = sanitizeSessionForSync(
      buildEgressProbeSession(),
      dataSyncLevelToMetadataContentPolicy(DataSyncLevel.Full)
    ).events;
    expect(Object.hasOwn(event, "data")).toBe(false);
    expect(Object.hasOwn(event, "summary")).toBe(false);
  });

  it("derives every per-level synced line from the real sync producer", () => {
    for (const level of DATA_SYNC_LEVELS) {
      const egressed = derivedEgressedClasses(level);
      for (const line of DATA_SYNC_LEVEL_COPY[level].dataLines) {
        if (egressed.has(line.label)) {
          expect(
            line.kind,
            `"${line.label}" at level "${level}" is copy-marked "local" but the sync producer ships it`
          ).toBe("sync");
          continue;
        }
        if (PARTIALLY_OBSERVED_CLASSES.has(line.label)) {
          // The probe watched only SOME of this class's channels, so "no
          // sentinel survived" does not license asserting "local" — that would
          // certify a claim against a lane this test never ran, and would then
          // block anyone correcting the copy for that lane. Only the direction
          // the probe can actually support is asserted.
          continue;
        }
        expect(
          line.kind,
          `"${line.label}" at level "${level}" is copy-marked "sync" but the sync producer does not ship it`
        ).toBe("local");
      }
    }
  });

  it("classifies every sync lane, and audits the ones that carry an envelope", () => {
    // Anti-vacuity guard for the `it.each` below: an empty ledger would make it
    // generate zero cases and report green. Also the runtime half of the
    // `Record<SyncLaneId, …>` — the type forces a key per lane at compile time,
    // this proves the set really is the canonical lane set and not a hand-copy that
    // drifted.
    expect(Object.keys(SYNC_LANE_EGRESS).toSorted()).toEqual(
      [...SYNC_LANE_IDS].toSorted()
    );
    expect(
      JSON_ENVELOPE_LANES.length,
      "no lane declares a JSON envelope — the ledger is empty and the per-envelope test below audits nothing"
    ).toBeGreaterThan(0);
  });

  it.each(JSON_ENVELOPE_LANES)(
    "accounts for every field on the serialized $typeName envelope",
    async ({ typeName, modulePath, declaredFields, accounting, observe }) => {
      // The content-class probe above reads the SESSION payload. It cannot see
      // the envelopes at all — that is how PR #5737 added a field to what leaves
      // the device on every batch with this file staying green.
      //
      // TWO SOURCES, UNIONED, because each is blind where the other sees (codex
      // P2 review).
      //
      // OBSERVED is the authority: the production client's own request body,
      // captured off an injected `fetch`. TypeScript checks assignability, not
      // the absence of extra properties — its excess-property check fires only on
      // a fresh literal assigned to an annotated target, so a spread-built
      // envelope (`{ ...payload, componentCount, components }`, live in
      // `desktop-components-client.ts`) can carry keys the declared type never
      // mentions and still compile. Only the bytes show those.
      //
      // DECLARED still runs, because observation has its own blind spot: an
      // OPTIONAL field the probe happens not to populate (`encoding`,
      // `wantsAcceptedSessionIds`) never appears in one captured body, and
      // dropping the AST read would quietly retire it from the audit. A field is
      // accounted for only if it is accounted for in BOTH directions.
      const declared =
        declaredFields?.() ?? declaredEnvelopeFields(modulePath, typeName);
      expect(
        declared.length,
        `found no members on ${typeName} — the AST read is broken, not the contract`
      ).toBeGreaterThan(0);
      const observed = await observe();
      expect(
        observed.length,
        `the production client serialized no ${typeName} fields — the capture is broken, so the observed half proves nothing`
      ).toBeGreaterThan(0);

      const onTheWire = [...new Set([...declared, ...observed])];
      const unaccounted = onTheWire.filter((field) => !(field in accounting));
      expect(
        unaccounted,
        `these fields leave the device on every ${typeName} batch and nothing says what the consent card owes them: ${unaccounted.join(", ")}`
      ).toEqual([]);
      const orphans = Object.keys(accounting).filter(
        (field) => !onTheWire.includes(field)
      );
      expect(
        orphans,
        `accounted-for fields that are neither declared on nor serialized by ${typeName}: ${orphans.join(", ")}`
      ).toEqual([]);
    }
  );

  it("still leaks on every known-unreconciled channel (ISS-7775)", () => {
    // The other half of the exclusion above, pinned CHANNEL BY CHANNEL rather
    // than by content class. Excluding the whole "Prompts & completions" class
    // would have let a genuinely-clean channel start leaking unnoticed — drop
    // the `{ task: _task, ...agent }` destructure from the producer's agent map
    // (ISS-6894) and raw delegation task text reaches the wire again, because
    // the field still exists on `SyncedAgentSessionAgent` for the transcript
    // reconstruction. Per-channel, that mutation reddens THIS test, because
    // only the four listed strings are excused; by content class it would not.
    //
    // And each listed channel must STILL leak: close one and this fails,
    // demanding its entry be deleted. A stale entry cannot quietly widen the
    // exclusion.
    expect(KNOWN_UNRECONCILED_EGRESS.length).toBeGreaterThan(0);
    // Asserted at `metadata`, the tier whose card calls this class local — so an
    // entry stays excused only while it leaks WHERE the copy is false. A channel
    // that egresses only at `full` is reconciled, not excused, and belongs in
    // neither this list nor this loop.
    const onTheWire = JSON.stringify(
      sanitizeSessionForSync(
        buildEgressProbeSession(),
        dataSyncLevelToMetadataContentPolicy(DataSyncLevel.Metadata)
      )
    );
    for (const { sentinel, channel } of KNOWN_UNRECONCILED_EGRESS) {
      expect(
        onTheWire.includes(sentinel),
        `${channel} no longer leaks — delete its KNOWN_UNRECONCILED_EGRESS entry and re-check the copy line`
      ).toBe(true);
    }
  });
});

/**
 * Content classes whose channels the probe watches only PARTLY, so a negative
 * result is "the session producer does not ship it", never "nothing does".
 *
 * `Tool inputs & file contents`: the component-inventory lane
 * (`agent-session-sync-component-lane.ts`) POSTs `SyncedComponent.content` —
 * definition FILE TEXT — on a gate that is open at the `metadata` tier
 * (`syncTierAllowsSessionMetadata`), which is what Metadata AND Redacted derive.
 * This test never runs that lane, so it must not certify the line as local; see
 * ISS-7777. `contracts.ts` documents that tier as keeping "file-contents local",
 * which the lane contradicts.
 */
const PARTIALLY_OBSERVED_CLASSES: ReadonlySet<string> = new Set([
  "Tool inputs & file contents",
]);

/**
 * Channels that leak a content class the copy calls local, TODAY. Excluded from
 * the survival computation so the guard can land, and each asserted still-leaking
 * by its sibling test so the exclusion cannot go stale.
 *
 * Not a mitigation and not permission — it records contradictions that already
 * ship, so this file can pin everything else without unilaterally deciding which
 * side changes. That call is ISS-7775. Excluded per CHANNEL, never per class, so
 * a clean channel in the same class stays fully guarded.
 *
 * FEA-2718 dropped turn text from the EVENT rows only. Every entry below is a
 * different channel it never touched.
 */
const KNOWN_UNRECONCILED_EGRESS: readonly {
  sentinel: string;
  channel: string;
}[] = [
  // ISS-7554, and the ONE prompt-class channel this ticket did not close.
  // `subagentName()` falls back to the first 60 chars of the raw delegation
  // prompt, and the producer ships `name` verbatim — ISS-6894 took the sibling
  // `task` field off the wire, but not this one. Unlike
  // every entry deleted below it, this one is NOT inside `metadata`: it is a
  // required, non-empty field of the agent wire row
  // (`syncedAgentSessionAgentSchema` — `z.string().trim().min(1)`), so closing
  // it means deciding what the cloud UI shows instead of a subagent's name.
  // That is a product call, not an implementation detail, so it stays excused
  // and the "Prompts & completions" line stays unreconciled until someone makes
  // it. Stated here rather than quietly folded in.
  {
    sentinel: "clsentinel-delegation-prompt",
    channel: "agents[].name (delegation-prompt prefix, ISS-7554)",
  },
  // ISS-7775, raised by the security-privacy critic on the fix PR and verified
  // here: the SESSION's own `name`. FEA-3578 made it the harness AI TITLE, which
  // the harness produces by summarizing the conversation (data-revision 31: "the
  // label users recognize from the Claude Code UI"), so it is prompt-DERIVED
  // content that the metadata allow-list cannot reach — it is a session-row
  // field and never enters `compactMetadataForPreview`.
  //
  // NOT closed here, and not because it is hard: `SyncedAgentSession.name` is
  // optional and nullable, so the producer COULD drop it. Doing so would leave
  // every session below `full` nameless in the cloud UI, which is a far larger
  // user-visible trade than the turn previews the operator approved, and
  // inventing a replacement label would be an implementation task deciding a
  // product question. Escalated on ISS-7775 instead.
  {
    sentinel: "clsentinel-session-name",
    channel: "session.name (harness AI title, FEA-3578)",
  },
  // ISS-7775 DELETED FIVE ENTRIES HERE, per this file's own instruction that a
  // closed channel must lose its excuse: `metadata.messages[].text` (both
  // roles), `metadata.plans[].content`,
  // `metadata.slashCommands[].definitionSnapshot.content`, and
  // `metadata.<any unenumerated key>` — the last of which was never a channel at
  // all but the statement that the list could not BE complete. It is closed by
  // construction now rather than by enumeration: below the `full` level the
  // sanitizer denies every string whose complete PATH is not declared
  // structural, so a key added to the blob tomorrow egresses nothing — and a
  // nested shape cannot borrow permission by reusing an allow-listed leaf name.
  // See `data-sync-tier-egress`.
];
/**
 * Run the PRODUCTION sync producer over the probe and report which content
 * classes actually reached the wire AT `level`. This is the runtime derivation
 * the per-level assertions read: making a class survive `sanitizeSessionForSync`
 * without flipping its copy line moves this set and fails the test.
 *
 * ISS-7775 made this take a level. It previously took none, because the producer
 * took none — which is precisely how a Metadata-only machine came to emit the
 * same bytes a Full one does under a card that said otherwise.
 */
function classesSurvivingSyncProducer(
  level: DataSyncLevel
): ReadonlySet<string> {
  const onTheWire = JSON.stringify(
    sanitizeSessionForSync(
      buildEgressProbeSession(),
      dataSyncLevelToMetadataContentPolicy(level)
    )
  );
  const excused = new Set(
    KNOWN_UNRECONCILED_EGRESS.map((entry) => entry.sentinel)
  );
  return new Set(
    Object.entries(EGRESS_PROBE_SENTINELS)
      .filter(([, sentinels]) =>
        sentinels.some(
          (sentinel) => !excused.has(sentinel) && onTheWire.includes(sentinel)
        )
      )
      .map(([label]) => label)
  );
}

/**
 * What a level actually lets leave, composed from the two runtime gates plus the
 * producer. ISS-7775 made `sanitizeSessionForSync` TIER-DEPENDENT — it now takes
 * the metadata content policy the level derives — so the level decides three
 * things: whether a payload is sent at all, what the payload may carry inside
 * `metadata`, and whether the separate transcript-archive lane also runs.
 *
 *  - connection off  → nothing leaves, whatever the producer would have emitted.
 *  - transcripts on  → every class, because that lane uploads raw transcript FILE
 *                      BYTES (`main/transcript-sync/`), which carry turn text,
 *                      tool inputs, and file contents wholesale.
 *  - otherwise       → exactly what survived the producer.
 */
/** Marks an envelope field that carries no session content of its own. */
const NO_CONSENT_LINE_OWED =
  "transport bookkeeping — carries no session content";

/**
 * What the consent card owes each field on the batch envelope. Hand-written, but
 * it cannot go stale in silence: the test above derives the field list from the
 * declared contract, so a missing entry fails and an orphaned entry fails. That
 * is the difference between this and the label literals it backstops — those
 * move only when someone edits copy.
 */
/**
 * What each desktop→cloud sync lane puts on the wire, and what the consent card
 * owes every field of it.
 *
 * KEYED BY `SyncLaneId`, AND THAT IS THE WHOLE POINT (codex P1 review). The
 * previous shape was an ARRAY that claimed to cover "every envelope the desktop
 * POSTs" and simply omitted the invocation-parts lane — a list cannot notice its
 * own gaps, so the claim was only as true as the last person to remember. A
 * `Record` over the canonical lane union makes `tsc` the enforcement: add a
 * lane to `SyncLaneId` (which any new lane must, or the burn-down prints
 * `ALL LANES FULLY SYNCED` while it still owes work) and this file stops
 * compiling until someone states what that lane egresses.
 *
 * Two lanes carry no single declared envelope type to enumerate. They are
 * recorded as such WITH the reason rather than left out, because "we looked and
 * there is nothing to enumerate" and "nobody looked" are the two things a bare
 * omission makes indistinguishable.
 */
type LaneEgressAccounting =
  | {
      kind: "json-envelope";
      typeName: string;
      modulePath: string;
      /**
       * The declared members, for an envelope declared as a Zod schema rather
       * than a type literal — the AST read below sees only type literals.
       */
      declaredFields?: () => readonly string[];
      /**
       * Drives the lane's REAL client and returns the top-level keys of the
       * body it serialized. This is the half a declaration cannot supply: an
       * excess property a producer actually emits is invisible to the type and
       * to the AST, and visible only here.
       */
      observe: () => Promise<string[]>;
      accounting: Record<string, string>;
    }
  | { kind: "no-declared-envelope"; why: string };

const SYNC_LANE_EGRESS: Record<SyncLaneId, LaneEgressAccounting> = {
  [SyncLaneId.SessionMetadata]: {
    kind: "json-envelope",
    typeName: "AgentSessionSyncBatch",
    modulePath: "../../../../main/agent-sync/agent-session-sync-contract.ts",
    observe: () => observeAgentSessionSyncBatchKeys(buildEgressProbeSession()),
    accounting: {
      schemaVersion: NO_CONSENT_LINE_OWED,
      batchId: NO_CONSENT_LINE_OWED,
      syncMode: NO_CONSENT_LINE_OWED,
      sessionCount: NO_CONSENT_LINE_OWED,
      encoding: NO_CONSENT_LINE_OWED,
      wantsAcceptedSessionIds: NO_CONSENT_LINE_OWED,
      // ISS-7516 — deliberately NOT `NO_CONSENT_LINE_OWED`. That constant
      // asserts "carries no session content", which is true here, and stops
      // there — which would be the wrong half of the answer for the one field
      // on this envelope that is not about the batch at all. It reports the
      // USER'S OWN PRIVACY SETTING to the cloud, and before this field the
      // level had no cloud representation whatsoever.
      dataSyncLevel:
        "the machine's own data-sync level when the batch was built — no session content, but the user's privacy CHOICE itself, which no consent line covers today; ISS-7848",
      sessions:
        "the session payload itself — its content classes are pinned by the probe above",
    },
  },
  // codex P1: the lane this ledger used to omit. It is enabled by
  // `isSessionMetadataSyncTierAllowed()` in `desktop-sync-lane-composition.ts`
  // — the component-INVENTORY lane below no longer shares that predicate, so do
  // not read the two as one gate any more — and its items carry
  // `definitionContent` — component definition FILE TEXT — exactly the class
  // `PARTIALLY_OBSERVED_CLASSES` already refuses to certify as local.
  [SyncLaneId.InvocationParts]: {
    kind: "json-envelope",
    typeName: "AgentComponentInvocationSyncBatch",
    modulePath:
      "../../../../../../../packages/api/src/types/agent-component-invocation.ts",
    observe: observeAgentComponentInvocationSyncBatchKeys,
    accounting: {
      protocolVersion: NO_CONSENT_LINE_OWED,
      parts:
        "invocation attribution rows, incl. `definitionContent` = definition FILE TEXT and `sourcePath` — no consent line covers either today; ISS-7777",
    },
  },
  [SyncLaneId.ComponentInventory]: {
    kind: "json-envelope",
    typeName: "DesktopAgentComponentsPayload",
    modulePath: "../../../../main/agent-sync/agent-session-sync-source.ts",
    observe: observeDesktopAgentComponentsPayloadKeys,
    accounting: {
      schemaVersion: NO_CONSENT_LINE_OWED,
      batchId: NO_CONSENT_LINE_OWED,
      syncMode: NO_CONSENT_LINE_OWED,
      componentCount: NO_CONSENT_LINE_OWED,
      components:
        "component inventory, incl. `content` = definition FILE TEXT — no consent line covers it today, and since #7707 no consent GATE holds it either: this lane is unconditional for an authenticated target; ISS-7777",
    },
  },
  [SyncLaneId.TranscriptArchive]: {
    kind: "no-declared-envelope",
    why: "uploads raw transcript FILE BYTES (`main/transcript-sync/`), not a typed JSON envelope — there is no field set to enumerate even in principle. Its content is modelled by pin 1 instead: the Full tier is derived as 'every class'.",
  },
};

/** The lanes that DO put a declared JSON envelope on the wire, in lane order. */
const JSON_ENVELOPE_LANES = SYNC_LANE_IDS.map((lane) => ({
  lane,
  entry: SYNC_LANE_EGRESS[lane],
}))
  .filter(
    (
      row
    ): row is {
      lane: SyncLaneId;
      entry: Extract<LaneEgressAccounting, { kind: "json-envelope" }>;
    } => row.entry.kind === "json-envelope"
  )
  .map(({ lane, entry }) => ({ lane, ...entry }));

/**
 * Member names of a declared envelope type literal, read from its module's AST
 * (a type has no runtime representation to enumerate).
 */
function declaredEnvelopeFields(
  modulePath: string,
  typeName: string
): string[] {
  const absolutePath = path.resolve(import.meta.dirname, modulePath);
  const source = ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const fields: string[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isTypeAliasDeclaration(statement) ||
      statement.name.text !== typeName ||
      !ts.isTypeLiteralNode(statement.type)
    ) {
      continue;
    }
    for (const member of statement.type.members) {
      if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
        fields.push(member.name.text);
      }
    }
  }
  return fields;
}

function derivedEgressedClasses(level: DataSyncLevel): ReadonlySet<string> {
  const booleans = dataSyncLevelToBooleans(level);
  if (!booleans.cloudConnectionEnabled) {
    return new Set();
  }
  if (booleans.transcriptSyncEnabled) {
    return new Set(Object.keys(EGRESS_PROBE_SENTINELS));
  }
  return classesSurvivingSyncProducer(level);
}
