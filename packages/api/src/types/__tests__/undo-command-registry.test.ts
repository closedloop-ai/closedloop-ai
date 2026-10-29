/**
 * Registry contract tests (ISS-9089).
 *
 * The inverse expectations below are written as INDEPENDENT literals — the
 * method, path and body are spelled out here rather than read back off the
 * registry. That duplication is the test: an inverse stubbed to a no-op, or
 * pointed at the wrong route, fails the case named for its own mutation kind.
 */
import { describe, expect, it } from "vitest";
import { ApiKeyScope } from "../api-key.js";
import { BATCH_MUTATION_ENTITY_LIMIT } from "../batch-mutation-limits.js";
import { Priority } from "../common.js";
import { DocumentStatus } from "../document.js";
import { TagEntityType } from "../tag.js";
import {
  isUndoableCommand,
  type UndoApiCall,
  UndoApiMethod,
  type UndoCommandContext,
  UndoEntityType,
  UndoMutationKind,
} from "../undo-command.js";
import {
  UNDO_COMMAND_REGISTRY,
  undoRegistryEntryFor,
} from "../undo-command-registry.js";

/**
 * Compile-time exhaustiveness guard (AC3). A member added to
 * `UndoMutationKind` without a registry entry makes `UnregisteredKinds`
 * non-`never`, which makes this annotation `never` and fails `tsc` — before any
 * test runs. A runtime "the registry has entries" assertion cannot see this.
 */
type UnregisteredKinds = Exclude<
  UndoMutationKind,
  keyof typeof UNDO_COMMAND_REGISTRY
>;
const unregisteredKindsIsEmpty: [UnregisteredKinds] extends [never]
  ? true
  : never = true;

/**
 * The mirror direction: a registry key that is NOT a declared mutation kind
 * (a typo, or a member the union dropped) fails `tsc` here.
 */
type UnknownRegistryKeys = Exclude<
  keyof typeof UNDO_COMMAND_REGISTRY,
  UndoMutationKind
>;
const unknownRegistryKeysIsEmpty: [UnknownRegistryKeys] extends [never]
  ? true
  : never = true;

const ARTIFACT_A = "11111111-1111-1111-1111-111111111111";
const ARTIFACT_B = "22222222-2222-2222-2222-222222222222";
/** Stands in for an id a PREVIOUS response reported (ISS-9465). */
const FORWARD_TRANSACTION_ID = "55555555-5555-4555-8555-555555555555";
const TAG_ID = "33333333-3333-3333-3333-333333333333";
/** Version and variant nibbles are real: `z.uuid()` enforces RFC 9562. */
const USER_ID = "44444444-4444-4444-8444-444444444444";

function singleEntityContext(
  prior: string | boolean | null,
  next: string | boolean | null
): UndoCommandContext {
  return {
    entity: { type: UndoEntityType.Artifact, ids: [ARTIFACT_A] },
    priorValue: { [ARTIFACT_A]: prior },
    newValue: { [ARTIFACT_A]: next },
    subject: { id: TAG_ID, label: "Blocked" },
    forwardChangedIds: [ARTIFACT_A],
  };
}

function twoEntityContext(
  priorA: string,
  priorB: string,
  next: string
): UndoCommandContext {
  return {
    entity: { type: UndoEntityType.Artifact, ids: [ARTIFACT_A, ARTIFACT_B] },
    priorValue: { [ARTIFACT_A]: priorA, [ARTIFACT_B]: priorB },
    newValue: { [ARTIFACT_A]: next, [ARTIFACT_B]: next },
    subject: { id: TAG_ID, label: "Blocked" },
    forwardChangedIds: [ARTIFACT_A, ARTIFACT_B],
  };
}

/**
 * A selection of `size` entities all moving to the same value. Used to drive
 * the batch-limit boundary, where only the COUNT matters.
 */
function sizedContext(
  size: number,
  value: string | boolean
): UndoCommandContext {
  const ids = Array.from({ length: size }, (_, index) => `artifact-${index}`);
  const priorValue: Record<string, string | boolean> = {};
  const newValue: Record<string, string | boolean> = {};
  for (const id of ids) {
    priorValue[id] = typeof value === "boolean" ? !value : DocumentStatus.Draft;
    newValue[id] = value;
  }
  return {
    entity: { type: UndoEntityType.Artifact, ids },
    priorValue,
    newValue,
    subject: { id: TAG_ID, label: "Blocked" },
    forwardChangedIds: ids,
  };
}

/**
 * `changedIds` is the server's report of what the forward actually moved, which
 * is what a tag inverse is built from. `priorValue` is still populated — the log
 * captures it — but is deliberately set to the OPPOSITE of what `changedIds`
 * implies for the untouched artifact, so a builder that regressed to inferring
 * from capture would produce a different request and fail.
 */
function tagMembershipContext(
  changedIds: readonly string[]
): UndoCommandContext {
  return {
    entity: { type: UndoEntityType.Artifact, ids: [ARTIFACT_A, ARTIFACT_B] },
    priorValue: { [ARTIFACT_A]: false, [ARTIFACT_B]: false },
    newValue: { [ARTIFACT_A]: true, [ARTIFACT_B]: true },
    subject: { id: TAG_ID, label: "Blocked" },
    forwardChangedIds: changedIds,
  };
}

/**
 * One row per undoable mutation kind: the context it ran in, and the exact
 * inverse request(s) that must come back. Nothing here is derived from the
 * registry.
 */
const INVERSE_EXPECTATIONS: ReadonlyArray<{
  kind: UndoMutationKind;
  context: UndoCommandContext;
  inverse: readonly UndoApiCall[];
}> = [
  {
    kind: UndoMutationKind.ArtifactStatusChange,
    context: singleEntityContext(DocumentStatus.Draft, DocumentStatus.InReview),
    inverse: [
      {
        method: UndoApiMethod.Put,
        path: `/documents/${ARTIFACT_A}`,
        requiredScope: ApiKeyScope.Write,
        body: { status: DocumentStatus.Draft },
      },
    ],
  },
  {
    kind: UndoMutationKind.ArtifactPriorityChange,
    context: singleEntityContext(Priority.Low, Priority.High),
    inverse: [
      {
        method: UndoApiMethod.Put,
        path: `/documents/${ARTIFACT_A}`,
        requiredScope: ApiKeyScope.Write,
        body: { priority: Priority.Low },
      },
    ],
  },
  {
    kind: UndoMutationKind.ArtifactAssigneeChange,
    context: singleEntityContext(null, USER_ID),
    inverse: [
      {
        method: UndoApiMethod.Put,
        path: `/documents/${ARTIFACT_A}`,
        requiredScope: ApiKeyScope.Write,
        body: { assigneeId: null },
      },
    ],
  },
  {
    kind: UndoMutationKind.ArtifactTagApply,
    context: singleEntityContext(false, true),
    inverse: [
      {
        method: UndoApiMethod.Delete,
        path: `/entity-tags?tagId=${TAG_ID}&entityType=${TagEntityType.Artifact}&entityId=${ARTIFACT_A}`,
        requiredScope: ApiKeyScope.Delete,
      },
    ],
  },
  {
    kind: UndoMutationKind.ArtifactTagRemove,
    context: singleEntityContext(true, false),
    inverse: [
      {
        method: UndoApiMethod.Post,
        path: "/entity-tags",
        requiredScope: ApiKeyScope.Write,
        body: {
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ARTIFACT_A,
        },
      },
    ],
  },
  {
    kind: UndoMutationKind.ArtifactBulkStatusChange,
    context: twoEntityContext(
      DocumentStatus.Draft,
      DocumentStatus.InReview,
      DocumentStatus.Approved
    ),
    inverse: [
      {
        method: UndoApiMethod.Post,
        path: "/documents/batch-update-status",
        requiredScope: ApiKeyScope.Write,
        body: { documentIds: [ARTIFACT_A], status: DocumentStatus.Draft },
      },
      {
        method: UndoApiMethod.Post,
        path: "/documents/batch-update-status",
        requiredScope: ApiKeyScope.Write,
        body: { documentIds: [ARTIFACT_B], status: DocumentStatus.InReview },
      },
    ],
  },
  {
    // The server reported changing only ARTIFACT_A — `createMany({
    // skipDuplicates })` left ARTIFACT_B alone because it already carried the
    // tag — so the inverse must strip A and leave B.
    kind: UndoMutationKind.ArtifactBulkTagApply,
    context: tagMembershipContext([ARTIFACT_A]),
    inverse: [
      {
        method: UndoApiMethod.Delete,
        path: `/entity-tags?tagId=${TAG_ID}&entityType=${TagEntityType.Artifact}&entityId=${ARTIFACT_A}`,
        requiredScope: ApiKeyScope.Delete,
      },
    ],
  },
  {
    kind: UndoMutationKind.ArtifactBulkTagRemove,
    context: tagMembershipContext([ARTIFACT_A]),
    inverse: [
      {
        method: UndoApiMethod.Post,
        path: "/entity-tags/batch",
        requiredScope: ApiKeyScope.Write,
        body: {
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityIds: [ARTIFACT_A],
        },
      },
    ],
  },
];

/**
 * The kinds this file expects to be undoable, and the kinds it expects to be
 * declared un-undoable — both written out by hand. If a command is flipped from
 * undoable to not (or the reverse) without this list being updated, the
 * declaration test below goes red rather than the change passing silently.
 */
const EXPECTED_UNDOABLE_KINDS: readonly UndoMutationKind[] = [
  UndoMutationKind.ArtifactStatusChange,
  UndoMutationKind.ArtifactPriorityChange,
  UndoMutationKind.ArtifactAssigneeChange,
  UndoMutationKind.ArtifactTagApply,
  UndoMutationKind.ArtifactTagRemove,
  UndoMutationKind.ArtifactBulkStatusChange,
  UndoMutationKind.ArtifactBulkTagApply,
  UndoMutationKind.ArtifactBulkTagRemove,
];

const EXPECTED_NON_UNDOABLE_KINDS: readonly UndoMutationKind[] = [
  UndoMutationKind.ArtifactBulkDelete,
  UndoMutationKind.ArtifactMerge,
];

describe("undo command registry", () => {
  it("holds the compile-time exhaustiveness guards", () => {
    // The guards are the two type annotations above; this asserts they were
    // actually evaluated rather than tree-shaken out of the module.
    expect(unregisteredKindsIsEmpty).toBe(true);
    expect(unknownRegistryKeysIsEmpty).toBe(true);
  });

  it("declares every mutation kind, undoable or not", () => {
    const declaredUndoable = Object.values(UNDO_COMMAND_REGISTRY)
      .filter((entry) => entry.undoable)
      .map((entry) => entry.kind)
      .sort();
    const declaredNonUndoable = Object.values(UNDO_COMMAND_REGISTRY)
      .filter((entry) => !entry.undoable)
      .map((entry) => entry.kind)
      .sort();

    expect(declaredUndoable).toEqual([...EXPECTED_UNDOABLE_KINDS].sort());
    expect(declaredNonUndoable).toEqual(
      [...EXPECTED_NON_UNDOABLE_KINDS].sort()
    );
  });

  it("keys every entry by its own kind", () => {
    for (const [key, entry] of Object.entries(UNDO_COMMAND_REGISTRY)) {
      expect(entry.kind).toBe(key);
    }
  });

  it("covers every undoable kind with a pinned inverse expectation", () => {
    const covered = INVERSE_EXPECTATIONS.map((row) => row.kind).sort();
    expect(covered).toEqual([...EXPECTED_UNDOABLE_KINDS].sort());
  });

  it.each(INVERSE_EXPECTATIONS)(
    "$kind: inverse issues the pinned apps/api request",
    ({ kind, context, inverse }) => {
      const entry = undoRegistryEntryFor(kind);
      if (!isUndoableCommand(entry)) {
        throw new Error(`${kind} is not declared undoable`);
      }
      expect(entry.inverse(context)).toEqual(inverse);
    }
  );

  it.each(INVERSE_EXPECTATIONS)(
    "$kind: inverse differs from forward",
    ({ kind, context }) => {
      const entry = undoRegistryEntryFor(kind);
      if (!isUndoableCommand(entry)) {
        throw new Error(`${kind} is not declared undoable`);
      }
      expect(entry.inverse(context)).not.toEqual(entry.forward(context));
    }
  );

  it.each(EXPECTED_NON_UNDOABLE_KINDS)(
    "%s: declares why it has no server-side inverse",
    (kind) => {
      const entry = undoRegistryEntryFor(kind);
      expect(entry.undoable).toBe(false);
      if (entry.undoable) {
        throw new Error(`${kind} unexpectedly declares an inverse`);
      }
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  );

  it("never strips a tag from an artifact the forward did not tag", () => {
    // Both artifacts already carried the tag, so `skipDuplicates` meant the
    // forward changed nothing and the server reported no changed ids. The
    // inverse must therefore issue NO request — the sibling case proves it does
    // issue one when the forward did act.
    const entry = undoRegistryEntryFor(UndoMutationKind.ArtifactBulkTagApply);
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_bulk_tag_apply is not declared undoable");
    }
    expect(entry.inverse(tagMembershipContext([]))).toEqual([]);
    expect(
      entry.inverse(tagMembershipContext([ARTIFACT_A, ARTIFACT_B]))
    ).toHaveLength(2);
  });

  it.each([
    UndoMutationKind.ArtifactTagApply,
    UndoMutationKind.ArtifactTagRemove,
    UndoMutationKind.ArtifactBulkTagApply,
    UndoMutationKind.ArtifactBulkTagRemove,
  ])("%s: refuses to invert without the forward's own result", (kind) => {
    // The forward is idempotent server-side, so a concurrent write can make it
    // a no-op for a row that capture believed it moved. Inferring the inverse
    // from `priorValue` alone would delete another caller's tag; the builder
    // must refuse instead.
    const entry = undoRegistryEntryFor(kind);
    if (!isUndoableCommand(entry)) {
      throw new Error(`${kind} is not declared undoable`);
    }
    const withoutForwardResult: UndoCommandContext = {
      entity: { type: UndoEntityType.Artifact, ids: [ARTIFACT_A] },
      priorValue: { [ARTIFACT_A]: false },
      newValue: { [ARTIFACT_A]: true },
      subject: { id: TAG_ID, label: "Blocked" },
    };
    expect(() => entry.inverse(withoutForwardResult)).toThrow(
      "the forward result was not captured"
    );
  });

  it("rejects a forward result naming an entity the command never targeted", () => {
    const entry = undoRegistryEntryFor(UndoMutationKind.ArtifactBulkTagApply);
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_bulk_tag_apply is not declared undoable");
    }
    const strayContext: UndoCommandContext = {
      entity: { type: UndoEntityType.Artifact, ids: [ARTIFACT_A] },
      priorValue: { [ARTIFACT_A]: false },
      newValue: { [ARTIFACT_A]: true },
      subject: { id: TAG_ID, label: "Blocked" },
      forwardChangedIds: [ARTIFACT_A, ARTIFACT_B],
    };
    expect(() => entry.inverse(strayContext)).toThrow(
      `never targeted: ${ARTIFACT_B}`
    );
  });

  it("refuses a bulk status forward whose captured targets disagree", () => {
    // A batch call sends ONE status for the whole selection. A context with two
    // different targets cannot be expressed as one call, and silently sending
    // the first id's status would move every selected artifact to it.
    const entry = undoRegistryEntryFor(
      UndoMutationKind.ArtifactBulkStatusChange
    );
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_bulk_status_change is not declared undoable");
    }
    const mixed: UndoCommandContext = {
      entity: { type: UndoEntityType.Artifact, ids: [ARTIFACT_A, ARTIFACT_B] },
      priorValue: {
        [ARTIFACT_A]: DocumentStatus.Draft,
        [ARTIFACT_B]: DocumentStatus.Draft,
      },
      newValue: {
        [ARTIFACT_A]: DocumentStatus.Approved,
        [ARTIFACT_B]: DocumentStatus.InReview,
      },
    };
    expect(() => entry.forward(mixed)).toThrow("one shared value");
    expect(
      entry.forward(
        twoEntityContext(
          DocumentStatus.Draft,
          DocumentStatus.Draft,
          DocumentStatus.Approved
        )
      )
    ).toHaveLength(1);
  });

  it("declares the scope each inverse request actually needs", () => {
    // Undoing a tag apply is a DELETE, which `apps/api` gates on the `delete`
    // scope while the forward POST only needs `write`. A caller holding a
    // write-only key can run the forward and cannot reverse it, so the
    // descriptor has to say so rather than surfacing a 403 at undo time.
    const entry = undoRegistryEntryFor(UndoMutationKind.ArtifactTagApply);
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_tag_apply is not declared undoable");
    }
    const context = singleEntityContext(false, true);
    expect(entry.forward(context).map((call) => call.requiredScope)).toEqual([
      ApiKeyScope.Write,
    ]);
    expect(entry.inverse(context).map((call) => call.requiredScope)).toEqual([
      ApiKeyScope.Delete,
    ]);
  });

  it.each([
    {
      kind: UndoMutationKind.ArtifactBulkStatusChange,
      value: DocumentStatus.Approved,
    },
    { kind: UndoMutationKind.ArtifactBulkTagApply, value: true },
    { kind: UndoMutationKind.ArtifactBulkTagRemove, value: false },
  ])(
    "$kind: refuses a selection larger than the route's batch limit",
    ({ kind, value }) => {
      // The route validators cap their id array at BATCH_MUTATION_ENTITY_LIMIT.
      // One request over a longer selection is a guaranteed 400 the caller only
      // meets at dispatch, after the undo was already offered.
      const entry = undoRegistryEntryFor(kind);
      if (!isUndoableCommand(entry)) {
        throw new Error(`${kind} is not declared undoable`);
      }
      expect(() =>
        entry.forward(sizedContext(BATCH_MUTATION_ENTITY_LIMIT + 1, value))
      ).toThrow(
        `exceeds the ${BATCH_MUTATION_ENTITY_LIMIT}-entity batch limit`
      );
      // The boundary itself is allowed, so the guard is a limit and not a ban.
      expect(
        entry.forward(sizedContext(BATCH_MUTATION_ENTITY_LIMIT, value))
      ).toHaveLength(1);
    }
  );

  it("refuses an over-limit bulk status inverse, not only the forward", () => {
    // The inverse groups by each row's own prior status, so a selection that is
    // uniform in prior status produces ONE group of the full size — the same
    // over-cap request the forward is guarded against.
    const entry = undoRegistryEntryFor(
      UndoMutationKind.ArtifactBulkStatusChange
    );
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_bulk_status_change is not declared undoable");
    }
    expect(() =>
      entry.inverse(
        sizedContext(BATCH_MUTATION_ENTITY_LIMIT + 1, DocumentStatus.Approved)
      )
    ).toThrow(`exceeds the ${BATCH_MUTATION_ENTITY_LIMIT}-entity batch limit`);
  });

  it("captures and replays a CLEARED priority as null, distinctly from a member (ISS-9665)", () => {
    // `PUT /documents/{id}` accepts `priority: null` to clear the field, so a
    // clear captures a null `newValue` and the first set on an unset artifact
    // captures a null `priorValue`. Both arms are exercised: a non-null capture
    // schema rejects the clear while the log is being written, and a non-null
    // reader throws building the inverse of the first set — an undo the user
    // was already offered.
    const entry = undoRegistryEntryFor(UndoMutationKind.ArtifactPriorityChange);
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_priority_change is not declared undoable");
    }
    expect(entry.valueSchema.safeParse(null).success).toBe(true);
    expect(entry.valueSchema.safeParse(Priority.High).success).toBe(true);
    expect(entry.valueSchema.safeParse("NONE").success).toBe(false);

    // Clearing HIGH: forward writes null, and the inverse restores HIGH.
    const cleared = singleEntityContext(Priority.High, null);
    expect(entry.forward(cleared)).toEqual([
      {
        method: UndoApiMethod.Put,
        path: `/documents/${ARTIFACT_A}`,
        requiredScope: ApiKeyScope.Write,
        body: { priority: null },
      },
    ]);
    expect(entry.inverse(cleared)).toEqual([
      {
        method: UndoApiMethod.Put,
        path: `/documents/${ARTIFACT_A}`,
        requiredScope: ApiKeyScope.Write,
        body: { priority: Priority.High },
      },
    ]);

    // The mirror: first set on an artifact that had none. Undoing it must put
    // the artifact back to UNSET — `null`, not a fabricated MEDIUM, and not a
    // dropped key that would leave the new priority in place.
    const firstSet = singleEntityContext(null, Priority.Urgent);
    expect(entry.inverse(firstSet)).toEqual([
      {
        method: UndoApiMethod.Put,
        path: `/documents/${ARTIFACT_A}`,
        requiredScope: ApiKeyScope.Write,
        body: { priority: null },
      },
    ]);
  });

  it("rejects a captured assignee that is not a uuid", () => {
    // `PUT /documents/{id}` validates `assigneeId` with `z.uuid().nullable()`.
    // A looser capture schema here would pass the log and 400 at undo time.
    const entry = undoRegistryEntryFor(UndoMutationKind.ArtifactAssigneeChange);
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_assignee_change is not declared undoable");
    }
    expect(entry.valueSchema.safeParse(USER_ID).success).toBe(true);
    expect(entry.valueSchema.safeParse(null).success).toBe(true);
    expect(entry.valueSchema.safeParse("marisol@example.com").success).toBe(
      false
    );
  });

  it("renders a counted, grammatical label for the toast", () => {
    const status = undoRegistryEntryFor(UndoMutationKind.ArtifactStatusChange);
    const bulk = undoRegistryEntryFor(
      UndoMutationKind.ArtifactBulkStatusChange
    );
    if (!(isUndoableCommand(status) && isUndoableCommand(bulk))) {
      throw new Error("expected both commands to be undoable");
    }
    expect(
      status.label(
        singleEntityContext(DocumentStatus.Draft, DocumentStatus.InReview)
      )
    ).toBe("Change status of 1 item");
    expect(
      bulk.label(
        twoEntityContext(
          DocumentStatus.Draft,
          DocumentStatus.InReview,
          DocumentStatus.Approved
        )
      )
    ).toBe("Change status of 2 items");
  });

  it("refuses to build an inverse when no entity was captured", () => {
    const entry = undoRegistryEntryFor(UndoMutationKind.ArtifactStatusChange);
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_status_change is not declared undoable");
    }
    const empty: UndoCommandContext = {
      entity: { type: UndoEntityType.Artifact, ids: [] },
      priorValue: {},
      newValue: {},
    };
    expect(() => entry.inverse(empty)).toThrow("no entity ids were captured");
  });

  it("rejects a captured status outside the artifact status vocabulary", () => {
    const entry = undoRegistryEntryFor(UndoMutationKind.ArtifactStatusChange);
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_status_change is not declared undoable");
    }
    expect(entry.valueSchema.safeParse(DocumentStatus.Approved).success).toBe(
      true
    );
    expect(entry.valueSchema.safeParse("APROVED").success).toBe(false);
  });

  it("refuses to build an inverse from an uncaptured prior value", () => {
    const entry = undoRegistryEntryFor(UndoMutationKind.ArtifactStatusChange);
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_status_change is not declared undoable");
    }
    const context: UndoCommandContext = {
      entity: { type: UndoEntityType.Artifact, ids: [ARTIFACT_A] },
      priorValue: {},
      newValue: { [ARTIFACT_A]: DocumentStatus.InReview },
    };
    expect(() => entry.inverse(context)).toThrow(
      `no captured value for entity ${ARTIFACT_A}`
    );
  });

  it("validates a captured prior value against the command's own schema", () => {
    const statusEntry = undoRegistryEntryFor(
      UndoMutationKind.ArtifactStatusChange
    );
    const tagEntry = undoRegistryEntryFor(UndoMutationKind.ArtifactTagApply);
    if (!(isUndoableCommand(statusEntry) && isUndoableCommand(tagEntry))) {
      throw new Error("expected both commands to be undoable");
    }
    expect(
      statusEntry.valueSchema.safeParse(DocumentStatus.Draft).success
    ).toBe(true);
    expect(statusEntry.valueSchema.safeParse(true).success).toBe(false);
    expect(tagEntry.valueSchema.safeParse(true).success).toBe(true);
    expect(tagEntry.valueSchema.safeParse(DocumentStatus.Draft).success).toBe(
      false
    );
  });
});

describe("an inverse names the transaction it reverses (ISS-10458)", () => {
  /**
   * The grouped bulk-status inverse. Its two rows held DIFFERENT prior
   * statuses, so the inverse is two calls — which is the shape a reference
   * carried per-call can go missing from.
   */
  function bulkStatusInverse(forwardTransactionId?: string) {
    const entry = undoRegistryEntryFor(
      UndoMutationKind.ArtifactBulkStatusChange
    );
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_bulk_status_change is not declared undoable");
    }
    const context: UndoCommandContext = {
      entity: { type: UndoEntityType.Artifact, ids: [ARTIFACT_A, ARTIFACT_B] },
      priorValue: {
        [ARTIFACT_A]: DocumentStatus.Draft,
        [ARTIFACT_B]: DocumentStatus.InReview,
      },
      newValue: {
        [ARTIFACT_A]: DocumentStatus.Approved,
        [ARTIFACT_B]: DocumentStatus.Approved,
      },
      ...(forwardTransactionId === undefined ? {} : { forwardTransactionId }),
    };
    return entry.inverse(context);
  }

  it("puts the forward's id on EVERY grouped call, not just the first", () => {
    const calls = bulkStatusInverse(FORWARD_TRANSACTION_ID);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.body?.undoOfTransactionId).toBe(FORWARD_TRANSACTION_ID);
    }
  });

  it("still carries the ids and statuses the inverse existed to send", () => {
    const calls = bulkStatusInverse(FORWARD_TRANSACTION_ID);

    expect(calls.map((call) => call.body?.status)).toEqual([
      DocumentStatus.Draft,
      DocumentStatus.InReview,
    ]);
    expect(calls.map((call) => call.body?.documentIds)).toEqual([
      [ARTIFACT_A],
      [ARTIFACT_B],
    ]);
  });

  it("OMITS the key when the forward reported no transaction", () => {
    // Omitted rather than `null`: the batch validators are `.strict()`, so a
    // null would have to be declared nullable at the route before the undo
    // could be sent at all.
    const calls = bulkStatusInverse();

    for (const call of calls) {
      expect(Object.hasOwn(call.body ?? {}, "undoOfTransactionId")).toBe(false);
    }
  });

  it("builds the body from the context, never from a value it minted", () => {
    const first = bulkStatusInverse("aaaaaaaa-1111-4111-8111-111111111111");
    const second = bulkStatusInverse("bbbbbbbb-2222-4222-8222-222222222222");

    expect(first[0].body?.undoOfTransactionId).toBe(
      "aaaaaaaa-1111-4111-8111-111111111111"
    );
    expect(second[0].body?.undoOfTransactionId).toBe(
      "bbbbbbbb-2222-4222-8222-222222222222"
    );
  });
});
