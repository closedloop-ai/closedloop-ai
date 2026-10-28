import { z } from "zod";
import {
  TOOL_CALL_DETAIL_STATES,
  type ToolItem,
} from "./agent-session-tool-call.ts";
import { BranchViewerScope } from "./branch.ts";
import type { BranchTracePageResult } from "./branch-trace-paging.ts";

/** Overall evidence state for Branch trace hydration and derived aggregates. */
export const BranchTraceCompletenessState = {
  Complete: "complete",
  Incomplete: "incomplete",
  Unavailable: "unavailable",
} as const;
export type BranchTraceCompletenessState =
  (typeof BranchTraceCompletenessState)[keyof typeof BranchTraceCompletenessState];

/** Per-Session result of trace-detail hydration. */
export const BranchTraceSessionHydrationState = {
  Loaded: "loaded",
  Unavailable: "unavailable",
} as const;
export type BranchTraceSessionHydrationState =
  (typeof BranchTraceSessionHydrationState)[keyof typeof BranchTraceSessionHydrationState];

/** Sanitized reason inventory; raw error messages never cross the contract. */
export const BranchTraceUnavailableReason = {
  NotFound: "not_found",
  Authentication: "authentication",
  Permission: "permission",
  Malformed: "malformed",
  Cancelled: "cancelled",
  PageFailure: "page_failure",
  LegacyResponse: "legacy_response",
  Unknown: "unknown",
} as const;
export type BranchTraceUnavailableReason =
  (typeof BranchTraceUnavailableReason)[keyof typeof BranchTraceUnavailableReason];

/**
 * Stable lightweight identity retained independently of event-heavy hydration.
 * `navigableRef` is a surface-neutral slug-or-id; each shell owns its route.
 */
export type BranchTraceSessionIdentity = {
  artifactId: string;
  name: string | null;
  slug: string | null;
  navigableRef: string;
  externalSessionId?: string;
};

export type BranchTraceSessionHydration =
  | {
      identity: BranchTraceSessionIdentity;
      state: typeof BranchTraceSessionHydrationState.Loaded;
      /**
       * ISS-9723: how many of this Session's built trace items
       * {@link mergedTraceItemSchema} refused, and which were therefore dropped
       * from `items` rather than repaired.
       *
       * The Session itself still LOADED — that is the ruling this field exists
       * to make legible. It rides the loaded variant rather than `completeness`
       * because the renderer needs to know WHICH Sessions are partial, not only
       * that some are, and because a scalar total plus a per-Session breakdown
       * would be two encodings of one fact that can drift.
       *
       * ABSENCE is the only encoding of "every item parsed", so a producer that
       * dropped nothing is byte-identical to one predating this field.
       */
      unreadableItemCount?: number;
    }
  | {
      identity: BranchTraceSessionIdentity;
      state: typeof BranchTraceSessionHydrationState.Unavailable;
      reason: BranchTraceUnavailableReason;
    };

export type BranchTraceCompleteness = {
  state: BranchTraceCompletenessState;
  reason?: BranchTraceUnavailableReason;
  /**
   * ISS-5075: `true` when at least one hydrated Session contributed only a
   * chronological PREFIX of its turns — its detail read hit the event-row
   * ceiling (`eventsTruncated`) — so the merged trace is built from partial
   * evidence even though every qualifying session hydrated.
   *
   * It rides ALONGSIDE `reason` rather than inside it deliberately: `reason` is
   * the sanitized `BranchTraceUnavailableReason` inventory for a session that
   * could not be READ at all, and a truncated session read fine. Keeping it a
   * separate optional field also keeps the change additive for a version-skewed
   * Desktop — `branchTraceCompletenessSchema` is not `.strict()`, so a client
   * predating this field strips it instead of rejecting the whole `traceState`.
   * ABSENCE is the only encoding of "nothing was cut".
   */
  eventsTruncated?: true;
};

/** Membership and completeness metadata repeated on every HTTP item page. */
export type BranchTraceState = {
  sessions: BranchTraceSessionHydration[];
  /** `null` is reserved for normalized legacy/failed responses with unknown membership. */
  qualifyingSessionCount: number | null;
  completeness: BranchTraceCompleteness;
  aggregateCompleteness: BranchTraceCompleteness;
};

/** Complete normalized result consumed by shared web/Desktop adapters. */
export type BranchTraceResult = BranchTraceState & {
  items: MergedTraceItem[];
};

/** Additive paged HTTP response. Older producers omit `traceState`. */
export type BranchTraceResponse = Pick<
  BranchTracePageResult,
  "nextCursor" | "overviewItems" | "reset"
> & {
  branchId: string;
  viewerScope: BranchViewerScope;
  items: MergedTraceItem[];
  hasMore: boolean;
  traceState?: BranchTraceState;
};

/** Runtime-normalized page that retains valid items when metadata is malformed. */
export type NormalizedBranchTracePage = {
  branchId: string;
  viewerScope: BranchViewerScope;
  items: MergedTraceItem[];
  hasMore: boolean;
  traceState: BranchTraceState | null;
  metadataReason?: BranchTraceUnavailableReason;
};

/**
 * Standalone discriminated union — authoritative for the branch merged-trace
 * renderer. It deliberately remains independent of the Sessions `TurnItem`.
 */
export type MergedTraceItem =
  | {
      type: "sessionstart";
      sessionId: string;
      t: string;
      actor: {
        name: string | null;
        harness: string | null;
        isResumed?: boolean;
        machine?: string | null;
        isNew?: boolean;
        ci?: boolean;
      };
    }
  | { type: "idle"; sessionId: string; t: string; gapMs: number }
  | {
      type: "prompt" | "say";
      sessionId: string;
      t: string;
      tMs: number;
      cumCostUsd: number | null;
      actorName: string | null;
      text: string;
    }
  | {
      type: "tools";
      sessionId: string;
      t: string;
      tMs: number;
      endMs: number;
      summary: string;
      hasFail: boolean;
      failN: number;
      items?: readonly ToolItem[];
    }
  | {
      type: "subagent";
      sessionId: string;
      t: string;
      tMs: number;
      sub: string;
      model: string | null;
      costUsd: number | null;
      costDeltaUsd?: number | null;
      cumCostUsd?: number | null;
    }
  | {
      type: "event";
      sessionId: string;
      t: string;
      dot: "g" | "b" | "r";
      text: string;
      tag?: string;
    }
  | { type: "end"; sessionId: string; text: string };

const branchTraceIdentityShape = {
  artifactId: z.string().min(1),
  name: z.string().nullable(),
  slug: z.string().min(1).nullable(),
  navigableRef: z.string().min(1),
  externalSessionId: z.string().min(1).optional(),
} satisfies Record<keyof BranchTraceSessionIdentity, z.ZodType>;

export const branchTraceSessionIdentitySchema = z.object(
  branchTraceIdentityShape
);

const loadedSessionSchema = z.object({
  identity: branchTraceSessionIdentitySchema,
  state: z.literal(BranchTraceSessionHydrationState.Loaded),
  // Positive, never zero: a `0` here would be a confident claim that this
  // Session was checked and nothing was dropped, which is what absence already
  // says without also having to be produced.
  unreadableItemCount: z.number().int().positive().optional(),
});

const unavailableSessionSchema = z.object({
  identity: branchTraceSessionIdentitySchema,
  state: z.literal(BranchTraceSessionHydrationState.Unavailable),
  reason: z.enum(BranchTraceUnavailableReason),
});

export const branchTraceSessionHydrationSchema = z.discriminatedUnion("state", [
  loadedSessionSchema,
  unavailableSessionSchema,
]);

export const branchTraceCompletenessSchema = z.object({
  state: z.enum(BranchTraceCompletenessState),
  reason: z.enum(BranchTraceUnavailableReason).optional(),
  eventsTruncated: z.literal(true).optional(),
} satisfies Record<keyof BranchTraceCompleteness, z.ZodType>);

const branchTraceStateShape = {
  sessions: z.array(branchTraceSessionHydrationSchema),
  qualifyingSessionCount: z.number().int().nonnegative().nullable(),
  completeness: branchTraceCompletenessSchema,
  aggregateCompleteness: branchTraceCompletenessSchema,
} satisfies Record<keyof BranchTraceState, z.ZodType>;

export const branchTraceStateSchema = z
  .object(branchTraceStateShape)
  .superRefine(validateTraceStateCount);

const traceSessionIdSchema = z.string().min(1);
const traceTimestampSchema = z
  .string()
  .min(1)
  .refine(isValidTraceTimestamp, "Trace timestamp must be parseable");
const traceActorSchema = z.object({
  name: z.string().nullable(),
  harness: z.string().nullable(),
  isResumed: z.boolean().optional(),
  machine: z.string().nullable().optional(),
  isNew: z.boolean().optional(),
  ci: z.boolean().optional(),
});
const traceToolItemSchema = z.object({
  label: z.string(),
  detail: z.string(),
  err: z.boolean(),
  id: z.string().optional(),
  callId: z.string().optional(),
  detailState: z.enum(TOOL_CALL_DETAIL_STATES).optional(),
  input: z.string().optional(),
  inputTruncated: z.boolean().optional(),
  output: z.string().optional(),
  outputTruncated: z.boolean().optional(),
  durationMs: z.number().optional(),
  status: z.string().optional(),
  transcriptIdentity: z
    .object({
      eventId: z.string().optional(),
      providerToolUseId: z.string().optional(),
      agentId: z.string().optional(),
      externalAgentId: z.string().optional(),
      userTurnId: z.string().optional(),
      timestamp: z.string().optional(),
      timestampOrdinal: z.number().optional(),
    })
    .optional(),
});
export const mergedTraceItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sessionstart"),
    sessionId: traceSessionIdSchema,
    t: traceTimestampSchema,
    actor: traceActorSchema,
  }),
  z.object({
    type: z.literal("idle"),
    sessionId: traceSessionIdSchema,
    t: traceTimestampSchema,
    gapMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.enum(["prompt", "say"]),
    sessionId: traceSessionIdSchema,
    t: traceTimestampSchema,
    tMs: z.number(),
    cumCostUsd: z.number().nullable(),
    actorName: z.string().nullable(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tools"),
    sessionId: traceSessionIdSchema,
    t: traceTimestampSchema,
    tMs: z.number(),
    endMs: z.number(),
    summary: z.string(),
    hasFail: z.boolean(),
    failN: z.number().int().nonnegative(),
    items: z.array(traceToolItemSchema).optional(),
  }),
  z.object({
    type: z.literal("subagent"),
    sessionId: traceSessionIdSchema,
    t: traceTimestampSchema,
    tMs: z.number(),
    sub: z.string(),
    model: z.string().nullable(),
    costUsd: z.number().nullable(),
    costDeltaUsd: z.number().nullable().optional(),
    cumCostUsd: z.number().nullable().optional(),
  }),
  z.object({
    type: z.literal("event"),
    sessionId: traceSessionIdSchema,
    t: traceTimestampSchema,
    dot: z.enum(["g", "b", "r"]),
    text: z.string(),
    tag: z.string().optional(),
  }),
  z.object({
    type: z.literal("end"),
    sessionId: traceSessionIdSchema,
    text: z.string(),
  }),
]) satisfies z.ZodType<MergedTraceItem>;

export const branchTraceResultSchema = z
  .object({
    items: z.array(mergedTraceItemSchema),
    ...branchTraceStateShape,
  })
  .superRefine(validateTraceResult);

const branchTracePageBaseSchema = z.object({
  branchId: z.string().min(1),
  viewerScope: z.enum(BranchViewerScope),
  items: z.array(z.unknown()),
  hasMore: z.boolean(),
  traceState: z.unknown().optional(),
});

/** Parse one unknown HTTP page without discarding valid items on metadata skew. */
export function normalizeBranchTracePage(
  input: unknown
): NormalizedBranchTracePage | null {
  const base = branchTracePageBaseSchema.safeParse(input);
  if (!base.success) {
    return null;
  }
  const parsedItems = parseMergedTraceItems(base.data.items);
  const parsedState =
    base.data.traceState === undefined
      ? null
      : branchTraceStateSchema.safeParse(base.data.traceState);
  const metadataReason = resolvePageMetadataReason(
    base.data.traceState,
    parsedState,
    parsedItems.malformed
  );
  return {
    branchId: base.data.branchId,
    viewerScope: base.data.viewerScope,
    items: parsedItems.items,
    hasMore: base.data.hasMore,
    traceState: parsedState?.success ? parsedState.data : null,
    ...(metadataReason ? { metadataReason } : {}),
  };
}

/**
 * Normalize a current Desktop result or legacy raw item array. Invalid metadata
 * degrades to unavailable while every individually valid loaded item survives.
 */
export function normalizeBranchTraceResult(input: unknown): BranchTraceResult {
  const current = branchTraceResultSchema.safeParse(input);
  if (current.success) {
    return current.data;
  }
  if (Array.isArray(input)) {
    const parsed = parseMergedTraceItems(input);
    return unavailableBranchTraceResult(
      parsed.items,
      parsed.malformed
        ? BranchTraceUnavailableReason.Malformed
        : BranchTraceUnavailableReason.LegacyResponse
    );
  }
  const items = extractValidItems(input);
  return unavailableBranchTraceResult(
    items,
    BranchTraceUnavailableReason.Malformed
  );
}

/** Construct an honest unknown/unavailable result for failed or legacy reads. */
export function unavailableBranchTraceResult(
  items: MergedTraceItem[] = [],
  reason: BranchTraceUnavailableReason = BranchTraceUnavailableReason.Unknown
): BranchTraceResult {
  return {
    items,
    sessions: [],
    qualifyingSessionCount: null,
    completeness: {
      state: BranchTraceCompletenessState.Unavailable,
      reason,
    },
    aggregateCompleteness: {
      state: BranchTraceCompletenessState.Unavailable,
      reason,
    },
  };
}

function parseMergedTraceItems(input: readonly unknown[]): {
  items: MergedTraceItem[];
  malformed: boolean;
} {
  const items: MergedTraceItem[] = [];
  let malformed = false;
  for (const value of input) {
    const parsed = mergedTraceItemSchema.safeParse(value);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      malformed = true;
    }
  }
  return { items, malformed };
}

function extractValidItems(input: unknown): MergedTraceItem[] {
  const objectWithItems = z
    .object({ items: z.array(z.unknown()) })
    .loose()
    .safeParse(input);
  return objectWithItems.success
    ? parseMergedTraceItems(objectWithItems.data.items).items
    : [];
}

function resolvePageMetadataReason(
  rawState: unknown,
  parsedState: ReturnType<typeof branchTraceStateSchema.safeParse> | null,
  malformedItems: boolean
): BranchTraceUnavailableReason | undefined {
  if (malformedItems || (parsedState && !parsedState.success)) {
    return BranchTraceUnavailableReason.Malformed;
  }
  if (rawState === undefined) {
    return BranchTraceUnavailableReason.LegacyResponse;
  }
  return undefined;
}

function validateTraceStateCount(
  value: BranchTraceState,
  context: z.RefinementCtx
): void {
  if (
    value.qualifyingSessionCount !== null &&
    value.qualifyingSessionCount !== value.sessions.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["qualifyingSessionCount"],
      message: "qualifyingSessionCount must match retained Session identities",
    });
  }
  const artifactIds = value.sessions.map(
    (session) => session.identity.artifactId
  );
  if (new Set(artifactIds).size !== artifactIds.length) {
    context.addIssue({
      code: "custom",
      path: ["sessions"],
      message: "Session identities must be unique by artifactId",
    });
  }
  const unavailableCount = value.sessions.filter(
    (session) => session.state === BranchTraceSessionHydrationState.Unavailable
  ).length;
  const loadedCount = value.sessions.length - unavailableCount;
  // ISS-9723: a Session can now LOAD and still have contributed fewer items
  // than it built, so "every Session loaded" no longer implies complete. Both
  // producers already refuse to claim `Complete` over a drop; enforcing it here
  // makes it a boundary invariant rather than a convention two callers keep.
  const anyItemUnreadable = value.sessions.some(
    (session) =>
      session.state === BranchTraceSessionHydrationState.Loaded &&
      (session.unreadableItemCount ?? 0) > 0
  );
  if (
    (value.completeness.state === BranchTraceCompletenessState.Complete ||
      value.aggregateCompleteness.state ===
        BranchTraceCompletenessState.Complete) &&
    (value.qualifyingSessionCount === null ||
      unavailableCount > 0 ||
      anyItemUnreadable)
  ) {
    context.addIssue({
      code: "custom",
      path: ["completeness"],
      message:
        "Complete trace evidence requires every retained Session to load whole",
    });
  }
  if (
    value.sessions.length > 0 &&
    loadedCount === 0 &&
    value.aggregateCompleteness.state !==
      BranchTraceCompletenessState.Unavailable
  ) {
    context.addIssue({
      code: "custom",
      path: ["aggregateCompleteness"],
      message:
        "An all-unavailable Session population has unavailable aggregates",
    });
  }
}

function validateTraceResult(
  value: BranchTraceResult,
  context: z.RefinementCtx
): void {
  validateTraceStateCount(value, context);
  const loadedSessionIds = new Set(
    value.sessions
      .filter(
        (session) => session.state === BranchTraceSessionHydrationState.Loaded
      )
      .map((session) => session.identity.artifactId)
  );
  for (const [index, item] of value.items.entries()) {
    if (!loadedSessionIds.has(item.sessionId)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "sessionId"],
        message: "Trace items must belong to a loaded retained Session",
      });
    }
  }
}

function isValidTraceTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/** A built merged trace split into what parsed and what was dropped. */
export type ReadableTracePartition = {
  items: MergedTraceItem[];
  /** Per-Session count of dropped items; a Session that lost none is absent. */
  unreadableCountBySession: Map<string, number>;
};

/**
 * ISS-9723: split a built merged trace into the items {@link
 * mergedTraceItemSchema} accepts and a per-Session count of the ones it refused.
 *
 * Both producers of a branch trace call this — the cloud read path and the
 * Desktop main-process builder — so the two surfaces drop the same items and
 * report the same counts from one definition.
 *
 * A refused item is DROPPED, never repaired. There is no trustworthy value to
 * fall back on for an item the contract cannot parse, and a substituted one
 * would render as a confident measurement; the count is what the reader is told
 * instead. Its Session survives: the ruling on ISS-9723 is that one unreadable
 * item must not take every readable item in that Session with it.
 *
 * SYNTHESIZED `idle` MARKERS GO WITH THEM. `buildMergedTrace` sizes a pause
 * against a running `activeUntilMs` that a refused item still extended — an item
 * can fail this schema on a field that has nothing to do with its extent (a
 * malformed `items[]` row) while its `endMs` was perfectly good. Keeping the
 * marker would state a pause measured over evidence no longer in the trace, and
 * the swimlane re-derives its own spans from the retained items alone
 * (`activeIdleSpans`, which skips embedded markers) — so the two would disagree
 * about one pause on one screen. Nothing here can recompute the marker, only
 * refuse to restate it, so a trace that dropped anything keeps no synthesized
 * pause at all. That is a gap, which the reader is told about; a contradiction
 * is not.
 */
export function partitionReadableTraceItems(
  built: readonly MergedTraceItem[],
  // ISS-9723 (#6884 review, davetho): drops the BUILDER already made, before
  // anything reached this schema. `buildMergedTrace` discards a turn whose `t`
  // will not parse, so such an item never appears in `built` and this partition
  // cannot see it — leaving "nothing was unreadable" and "an unreadable item was
  // removed upstream" as one answer, and letting the trace claim `Complete` over
  // an item it dropped. Seeded rather than merged by each caller so the two
  // producers cannot diverge on how a builder drop is counted.
  discardedBySession: ReadonlyMap<string, number> = new Map()
): ReadableTracePartition {
  const readable: MergedTraceItem[] = [];
  const unreadableCountBySession = new Map<string, number>(discardedBySession);
  for (const item of built) {
    const parsed = mergedTraceItemSchema.safeParse(item);
    if (parsed.success) {
      readable.push(parsed.data);
      continue;
    }
    const sessionId = item.sessionId;
    unreadableCountBySession.set(
      sessionId,
      (unreadableCountBySession.get(sessionId) ?? 0) + 1
    );
  }
  // Only a REFUSED ITEM counts as unreadable — a schema rejection here, or a
  // turn the builder could not place in time. A marker withdrawn because it can
  // no longer be measured is a consequence of that, not a second loss. The
  // builder's drops withdraw markers for the same reason from the other
  // direction: an unplaceable turn never entered the running `activeUntilMs`, so
  // a pause spanning it is measured over a window activity is known to have
  // occurred in, and restating it would call that window quiet.
  const items =
    unreadableCountBySession.size === 0
      ? readable
      : readable.filter((item) => item.type !== "idle");
  return { items, unreadableCountBySession };
}

/** Attach a positive drop count to a loaded Session, omitting a zero. */
export function withUnreadableItemCount(
  session: BranchTraceSessionHydration,
  unreadableCountBySession: ReadonlyMap<string, number>
): BranchTraceSessionHydration {
  if (session.state !== BranchTraceSessionHydrationState.Loaded) {
    return session;
  }
  const count = unreadableCountBySession.get(session.identity.artifactId) ?? 0;
  return count > 0 ? { ...session, unreadableItemCount: count } : session;
}
