import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { describe, expect, it } from "vitest";
import { sanitizeSessionForSync } from "../../../../main/agent-sync/agent-session-sync-payload";
import { dataSyncLevelToMetadataContentPolicy } from "../../../../shared/data-sync-level";
import {
  AGENT_METADATA_COLLIDING_STRUCTURAL_KEY,
  BENIGN_SECRET_LOOKALIKE,
  buildEgressProbeSession,
  NESTED_MESSAGES_HOLDER_KEY,
  OMITTED_METADATA_SENTINEL,
  SECRET_IN_AGENT_METADATA,
  SECRET_IN_DEFINITION_CONTENT,
  SECRET_IN_MESSAGE_TEXT,
  SECRET_IN_NESTED_MESSAGE_TEXT,
  SECRET_IN_UNENUMERATED_METADATA,
  UNENUMERATED_METADATA_KEY,
} from "./data-sync-egress-probe";

// ISS-7775 + ISS-8014 — what each data-sync LEVEL is allowed to put on the sync
// wire, and what is masked inside whatever it does put there.
//
// The sibling `data-sync-egress-honesty.test.ts` pins the consent CARD against
// the producer. This file pins the producer against itself, because the two
// questions fail differently: a card and an egress set can agree while the
// egress set is open, which is exactly the state ISS-7775 found.
//
// ══ WHY THE ASSERTIONS BELOW ARE SHAPED THE WAY THEY ARE ══
//
// AN UNENUMERATED KEY IS THE ONLY DECISIVE PROBE. PR #5933 proved
// `compactMetadataForPreview` was a DENY-list with bounds: keys the lane
// INVENTED (`arbitraryFutureKey`, `nested.deep.deeper`) reached the wire. So a
// test that plants sentinels in the five known channels and asserts they are
// gone would pass against a fix that closed exactly those five and left the set
// open — reproducing the defect one level up, with a longer list. Every
// assertion here that matters is therefore made against
// `UNENUMERATED_METADATA_KEY`, a key nothing in this repo names.
//
// THE TIER LIST IS PINNED WITH INDEPENDENT LITERALS, not derived from
// `DATA_SYNC_LEVELS`. Deriving the expectation from the enum under policing
// would keep this green through a level being added, renamed, or re-ranked —
// the same reason the negative control below reads `tokenSeries` as a literal
// rather than out of `OMITTED_METADATA_KEYS`.
//
// POSITIVE CONTROLS ARE NOT OPTIONAL HERE. Every ISS-7775 assertion is satisfied
// by an ABSENT string, and every ISS-8014 assertion by an absent one too, so a
// producer that emitted `{}` — or a redactor that blanked everything — would
// pass the whole file. `retains prompt text at full` and
// `leaves a benign secret-shaped string byte-identical` are what make the
// absences mean something.
//
// NO ASSERTION COMPARES SUBSTRINGS AGAINST A SENTINEL. `expect(x).not
// .toContain(secret)` renders the secret into stdout, the HTML report, and
// `playwright-results.json` on failure; booleans are compared instead so a red
// run prints a policy question and not a token. Nothing planted here is, or ever
// was, a live credential.

describe("data-sync level → what may leave inside `metadata`", () => {
  it("withholds prompt-class content at every level below full", () => {
    // The tiers named as literals (see header). `off` is excluded deliberately:
    // it sends no payload at all, so asking what its payload contains is a
    // question about a thing that does not exist.
    for (const level of [DataSyncLevel.Metadata, DataSyncLevel.Redacted]) {
      const onTheWire = wireText(level);
      expect(
        onTheWire.includes("clsentinel-user-prompt"),
        `${level} shipped user turn text from metadata.messages[].text`
      ).toBe(false);
      expect(
        onTheWire.includes("clsentinel-assistant-completion"),
        `${level} shipped assistant turn text from metadata.messages[].text`
      ).toBe(false);
      expect(
        onTheWire.includes("clsentinel-plan-prose"),
        `${level} shipped plan prose from metadata.plans[].content`
      ).toBe(false);
      expect(
        onTheWire.includes("clsentinel-definition-content"),
        `${level} shipped definition file text from metadata.slashCommands[].definitionSnapshot.content`
      ).toBe(false);
      expect(
        onTheWire.includes("clsentinel-agent-metadata"),
        `${level} shipped free text from the agents[].metadata blob`
      ).toBe(false);
    }
  });

  it("closes the metadata key set BY CONSTRUCTION, not by enumeration", () => {
    // THE DECISIVE ASSERTION OF ISS-7775. The sentinel below sits under a key no
    // policy in this repo mentions: not in `OMITTED_METADATA_KEYS`, not
    // special-cased, not read by any consumer. Under the deny-list this file
    // replaces it reached the wire as a 1024-char slice.
    //
    // If this ever goes red while the five named channels stay green, the
    // sanitizer has been turned back into a deny-list and the fix has been
    // undone in the only way that looks like it still works.
    for (const level of [DataSyncLevel.Metadata, DataSyncLevel.Redacted]) {
      expect(
        wireText(level).includes("clsentinel-unenumerated-metadata"),
        `${level} shipped a string under \`${UNENUMERATED_METADATA_KEY}\` — a key nothing declares structural, so the sanitizer is retaining unknown keys again and the channel set is open`
      ).toBe(false);
    }
  });

  it("denies an undeclared shape that reuses an allow-listed key name", () => {
    // The nested twin of the assertion above, and the one that distinguishes a
    // PATH allow-list from a leaf-key one (review: whitlockk + the security-privacy
    // critic, both on this PR). The probe plants a `messages` array under a key
    // with no policy. Under a leaf-key match its `role`/`timestamp` inherited
    // `messages.role`'s permission and its turn text rode the `messages` special
    // case; under the path match nothing inside an undeclared holder is
    // structural, so the whole shape must be empty of strings.
    //
    // Asserted on the holder's own subtree rather than the whole payload, so a
    // sibling channel going quiet cannot make this pass for the wrong reason.
    for (const level of [DataSyncLevel.Metadata, DataSyncLevel.Redacted]) {
      const holder = JSON.stringify(
        metadataOf(level)[NESTED_MESSAGES_HOLDER_KEY] ?? null
      );
      expect(
        holder.includes("clsentinel-nested-message"),
        `${level} shipped nested turn text under \`${NESTED_MESSAGES_HOLDER_KEY}\``
      ).toBe(false);
      expect(
        holder.includes("user"),
        `${level} shipped \`role\` under \`${NESTED_MESSAGES_HOLDER_KEY}\` — an undeclared shape inherited \`messages.role\`, so the allow-list is matching the leaf key again`
      ).toBe(false);
    }
  });

  it("denies an agents[].metadata key that collides with a session structural path", () => {
    // The CONTAINER twin of the two assertions above (review: davetho).
    // `agents[].metadata` is compacted as its own root, so a path set keyed from
    // the SESSION root judged an agent's root key `gitBranch` as the session's
    // `gitBranch` slot and retained it. That is borrow-by-collision again — the
    // exact defect the path allow-list replaced the leaf-key one to close — one
    // container down, and reachable because `buildSubagentMetadata` spreads the
    // parser's own keys into that blob.
    //
    // Scoped to the AGENT's own subtree, because the identical key is legitimately
    // retained at the session root (it is the redactor's control there); asserting
    // over the whole payload could never tell the two apart.
    for (const level of [DataSyncLevel.Metadata, DataSyncLevel.Redacted]) {
      expect(
        agentMetadataText(level).includes("clsentinel-agent-path-collision"),
        `${level} shipped a string from \`agents[].metadata.${AGENT_METADATA_COLLIDING_STRUCTURAL_KEY}\` — the agent blob is being judged against the SESSION path set, so an agent can borrow any session slot's permission by reusing its root key`
      ).toBe(false);
    }
  });

  it("keeps the session-shape metadata the tier does advertise", () => {
    // The other half of "closed by construction": a policy that answered the
    // question above by emitting nothing would also pass it. These are the
    // structural values the Metadata card DOES promise, so their survival is
    // what proves the narrowing discriminates rather than blanks.
    const wire = JSON.parse(
      JSON.stringify(
        sanitizeSessionForSync(
          buildEgressProbeSession(),
          dataSyncLevelToMetadataContentPolicy(DataSyncLevel.Metadata)
        )
      )
    ) as { metadata: { messages: { role?: string; text?: string }[] } };
    const [firstMessage] = wire.metadata.messages;
    expect(firstMessage.role, "the turn's role is session shape").toBe("user");
    expect(
      Object.hasOwn(firstMessage, "text"),
      "the turn survives on the timeline carrying no text, rather than vanishing from it"
    ).toBe(false);
  });

  it("retains prompt text at full, so the absences above are a policy and not an empty producer", () => {
    // POSITIVE CONTROL for every negative assertion in this file. Without it,
    // a producer that returned `{}` for all four levels would pass them all.
    const onTheWire = wireText(DataSyncLevel.Full);
    expect(
      onTheWire.includes("clsentinel-user-prompt"),
      "full no longer ships turn text — the probe cannot observe retention, so every `withheld` assertion in this file is vacuous"
    ).toBe(true);
    expect(
      onTheWire.includes("clsentinel-plan-prose"),
      "full no longer ships plan prose — see above"
    ).toBe(true);
    expect(
      onTheWire.includes("clsentinel-unenumerated-metadata"),
      "full no longer ships an unenumerated metadata key — see above"
    ).toBe(true);
    // The two channels THIS change newly closed need the control most: without
    // them, replacing `agents[].metadata` with a bare `null` (or dropping
    // `slashCommands` from the blob) would leave every assertion about those
    // channels green while testing a string the producer never emitted.
    expect(
      onTheWire.includes("clsentinel-agent-metadata"),
      "full no longer ships the agents[].metadata blob — its withheld/redacted assertions are now about a string nothing emits"
    ).toBe(true);
    expect(
      onTheWire.includes("clsentinel-definition-content"),
      "full no longer ships slash-command definition text — its withheld/redacted assertions are now about a string nothing emits"
    ).toBe(true);
    // Control for the collision assertion specifically, and asserted on the AGENT
    // subtree for the same reason that assertion is: the namespacing must deny the
    // key below full WITHOUT deleting the agent blob outright, or the denial is
    // indistinguishable from a producer that stopped emitting `agents[].metadata`.
    expect(
      agentMetadataText(DataSyncLevel.Full).includes(
        "clsentinel-agent-path-collision"
      ),
      "full no longer ships the colliding agents[].metadata key — the namespacing deleted the blob instead of re-scoping it, so the collision assertion is vacuous"
    ).toBe(true);
  });

  it("still drops the omitted key at full, so `retained` is a real discrimination", () => {
    // NEGATIVE CONTROL on the same mechanism, at the level that retains the
    // most: `tokenSeries` is pinned as an independent literal rather than read
    // from `OMITTED_METADATA_KEYS`, because deriving the expectation from the
    // policy under test would keep it green whatever that policy became.
    expect(
      wireText(DataSyncLevel.Full).includes(OMITTED_METADATA_SENTINEL),
      "the probe's `tokenSeries` sentinel survived the producer, so this file cannot tell a retained key from a dropped one"
    ).toBe(false);
  });
});

describe("secret redaction across the whole metadata path (ISS-8014)", () => {
  it("redacts a secret under a key nothing in this repo names", () => {
    // THE DECISIVE ASSERTION OF ISS-8014. Before it, `redactSecrets` was
    // reachable ONLY from the `messages` special case, so the identical token
    // came back `[REDACTED:sk-ant]` in a chat turn and INTACT in a slash-command
    // definition. An enumerated-channel test cannot catch that, because the
    // retained key set is open at `full`: this plants the secret where no
    // enumeration reaches.
    expect(
      wireText(DataSyncLevel.Full).includes(SECRET_IN_UNENUMERATED_METADATA),
      "a secret-shaped token under an unenumerated metadata key reached the wire — redaction is enumerated per channel again, so the channels nobody listed are unprotected"
    ).toBe(false);
  });

  it("redacts every metadata channel the probe can reach, at the level that retains them", () => {
    // Asserted at `full` ON PURPOSE. Below it these channels do not egress at
    // all, so a green result there would be the TIER doing the work and would
    // say nothing about the redactor — the vacuous shape this file exists to
    // avoid.
    const onTheWire = wireText(DataSyncLevel.Full);
    expect(
      onTheWire.includes(SECRET_IN_MESSAGE_TEXT),
      "a secret in metadata.messages[].text reached the wire"
    ).toBe(false);
    expect(
      onTheWire.includes(SECRET_IN_DEFINITION_CONTENT),
      "a secret in metadata.slashCommands[].definitionSnapshot.content reached the wire"
    ).toBe(false);
    expect(
      onTheWire.includes(SECRET_IN_AGENT_METADATA),
      "a secret in the agents[].metadata blob reached the wire"
    ).toBe(false);
    expect(
      onTheWire.includes(SECRET_IN_NESTED_MESSAGE_TEXT),
      "a secret in a NESTED metadata.<undeclared>.messages[].text reached the wire — redaction is depth-dependent again"
    ).toBe(false);
  });

  it("marks what it matched, so a redaction is recognizable rather than a silent hole", () => {
    // The repo rule is that a redaction marker is emitted only where non-empty
    // sensitive content actually matched. This is the "it did match" half; the
    // "it did not" half is the byte-identical control below.
    //
    // Read off the UNENUMERATED key's own value rather than off the whole
    // payload: `messages[].text` has always been redacted, so a payload-wide
    // marker search stays green through a regression that leaves every other
    // channel unmasked — it would be asserting the one channel that was never
    // broken.
    const wire = JSON.parse(
      JSON.stringify(
        sanitizeSessionForSync(
          buildEgressProbeSession(),
          dataSyncLevelToMetadataContentPolicy(DataSyncLevel.Full)
        )
      )
    ) as { metadata: Record<string, unknown> };
    expect(
      String(wire.metadata[UNENUMERATED_METADATA_KEY]).includes(
        "[REDACTED:sk-ant]"
      ),
      "the unenumerated key's value carries no redaction marker — its secret is absent because the key was dropped or the value blanked, not because the redactor replaced it"
    ).toBe(true);
  });

  it("leaves a benign secret-shaped string byte-identical", () => {
    // POSITIVE CONTROL for the redactor itself. Widening redaction from one
    // channel to every string is exactly the change that could start mangling a
    // user's own prose, and "no secret on the wire" is equally satisfied by a
    // redactor that blanks everything. This string shares the alphabet and
    // length class of the tokens above and must survive untouched — at BOTH the
    // widest and the narrowest level, since it sits under a structural key.
    for (const level of [DataSyncLevel.Full, DataSyncLevel.Metadata]) {
      expect(
        wireText(level).includes(BENIGN_SECRET_LOOKALIKE),
        `${level} mangled a benign secret-shaped string — the redactor is over-matching and is rewriting content the user wrote`
      ).toBe(true);
    }
  });
});

/** The probe as the production producer would serialize it at `level`. */
function wireText(level: DataSyncLevel): string {
  return JSON.stringify(
    sanitizeSessionForSync(
      buildEgressProbeSession(),
      dataSyncLevelToMetadataContentPolicy(level)
    )
  );
}

/** The emitted `agents[].metadata` blobs at `level`, for a subtree-scoped assertion. */
function agentMetadataText(level: DataSyncLevel): string {
  return JSON.stringify(
    sanitizeSessionForSync(
      buildEgressProbeSession(),
      dataSyncLevelToMetadataContentPolicy(level)
    ).agents.map((agent) => agent.metadata)
  );
}

/** The emitted `metadata` blob at `level`, for a subtree-scoped assertion. */
function metadataOf(level: DataSyncLevel): Record<string, unknown> {
  return (sanitizeSessionForSync(
    buildEgressProbeSession(),
    dataSyncLevelToMetadataContentPolicy(level)
  ).metadata ?? {}) as Record<string, unknown>;
}
