"use client";

import {
  GRID_PREFERENCE_ROUTE,
  type GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceReadStatus,
  type GridPreferenceScopeKey,
  type GridPreferenceSelector,
} from "@repo/api/src/types/grid-preferences";
import {
  gridPreferenceReadResponseSchema,
  gridPreferenceUpsertResponseSchema,
} from "@repo/api/src/types/grid-preferences-schema";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../api/create-api-client";
import { useApiClientOptional } from "../api/use-api-client-optional";
import { useOptionalAuthSnapshot } from "../auth/use-auth-snapshot";
import { useFeatureFlagEnabledOptional } from "../feature-flags/use-feature-flag-enabled";
import { GRID_PREFERENCE_SERVER_PERSISTENCE_FEATURE_FLAG_KEY } from "../lib/feature-flags";
import {
  canonicalJsonString,
  type GridPreferenceRemoteState,
  isWithinGridPreferenceValueCap,
  parseJsonObject,
  planGridPreferenceAdoption,
} from "../lib/grid-preference-import";

/**
 * How long a burst of view changes is collected before one authoritative write
 * goes out. A drag-resize emits a width per pointer move and a reorder emits an
 * order per drop, so writing per change would be one request per frame.
 *
 * Deliberately short. It is also the window in which a change exists on this
 * device only: {@link useGridPreferenceRemote} flushes on unmount so an in-app
 * navigation cannot strand one, but a tab closed mid-window leaves the change in
 * `localStorage` alone, where the next mount's adopt-the-server rule replaces it.
 */
export const GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS = 400;

export const GRID_PREFERENCE_CONFLICT_MESSAGE =
  "Your column layout changed elsewhere. Showing the layout saved to your account.";

export const GRID_PREFERENCE_ROLLBACK_MESSAGE =
  "Couldn't save your column layout. Reverted to the last layout saved to your account.";

export const GRID_PREFERENCE_WRITE_FAILED_MESSAGE =
  "Couldn't save your column layout to your account. It is still saved on this device.";

/**
 * Serialized view bytes the SERVER is authoritative for, tagged so the consumer
 * applies each delivery exactly once. `seq` rather than value identity, because
 * a rollback can legitimately re-deliver bytes the consumer has already seen —
 * the same layout arriving for a different reason.
 */
export type GridPreferenceInbound = { serialized: string; seq: number };

export type GridPreferenceRemote = {
  inbound: GridPreferenceInbound | null;
  /**
   * Report the bytes now persisted locally. A no-op when server persistence is
   * closed, when the surface has no identity, or when the bytes already match
   * what the server confirmed. Before the account's own copy has been read,
   * this BUFFERS rather than writes — see `adopted` on the sync state.
   */
  publish: (serialized: string) => void;
};

/**
 * Mirror one surface's persisted table view into the authenticated
 * `grid_preferences` store opened by ISS-9448 (ISS-9450).
 *
 * Reads the account's stored layout on mount, imports the local one when the
 * server holds none, and writes every later change back debounced. It owns NO
 * representation of its own: the bytes it sends and receives are exactly the
 * ones `usePersistedTableViewState` already writes to `localStorage` through
 * ISS-9447's codec, carried as the route's opaque `value` — so an axis this
 * build cannot name round-trips untouched in both directions, and there is no
 * second codec, key family or table to keep in step.
 *
 * **The flag is read HERE, where the behaviour swaps**, never threaded in — a
 * consumer that needs it reads it itself (`no-threaded-feature-flag`). Closed,
 * and while the assignment is unresolved, `publish` is inert and `inbound` stays
 * null, so the surface behaves exactly as it shipped: `localStorage` only, no
 * request, nothing imported.
 *
 * **Local data is never deleted by this hook.** The `localStorage` record stays
 * the surface's own store; the server is a second, authoritative copy this hook
 * seeds from it and then keeps in step.
 */
export function useGridPreferenceRemote(options: {
  gridKey?: GridPreferenceGridKey;
  scopeKey: GridPreferenceScopeKey;
  storageKey: string | null;
}): GridPreferenceRemote {
  const { gridKey, scopeKey, storageKey } = options;
  const enabled = useFeatureFlagEnabledOptional(
    GRID_PREFERENCE_SERVER_PERSISTENCE_FEATURE_FLAG_KEY
  );
  const client = useApiClientOptional();
  const { orgId, userId } = useOptionalAuthSnapshot();

  // Server preferences are per-account rows, so a surface with no identity has
  // nothing to sync: the `localStorage` key it writes is the un-namespaced
  // legacy one, whose contents belong to whoever last used this browser profile.
  const selector = useMemo(
    (): GridPreferenceSelector | null =>
      gridKey === undefined ||
      storageKey === null ||
      userId === null ||
      !enabled
        ? null
        : { gridKey, preferenceKind: GridPreferenceKind.ViewState, scopeKey },
    [enabled, gridKey, scopeKey, storageKey, userId]
  );
  const active = selector !== null && client !== null && storageKey !== null;

  const [inbound, setInbound] = useState<GridPreferenceInbound | null>(null);
  const syncRef = useRef<GridPreferenceSyncState>(newSyncState());
  const seqRef = useRef(0);
  // The client OBJECT, read at use time rather than captured, and deliberately
  // not part of the row identity below. On desktop it is rebuilt on every
  // access-token refresh with the account behind it unchanged:
  // `DesktopSessionManager.applyTokens` re-pushes the auth state, the renderer's
  // bridge store compares nothing before notifying, the provider's adapter memo
  // is keyed on that state, and `useApiClientOptional` is keyed on the resulting
  // `getToken`. Treating that as a new row discarded the pending write, cancelled
  // the sync owning any in-flight POST, and re-delivered the server's pre-edit
  // layout — once per token lifetime, most likely triggered by this hook's own
  // POST (marisolashgrove review, PR #7081).
  const clientRef = useRef(client);
  clientRef.current = client;
  // The row the hook is CURRENTLY rendering for, recorded during render so the
  // effect cleanup can tell the two reasons it runs apart. On an unmount
  // nothing re-rendered, so this still names the row the effect captured; on a
  // REPLACEMENT — the gate closing, the reader signing out, a scope, account or
  // ORGANIZATION switch — React has already rendered the new one, and the four
  // fields differ. Only the first may flush: posting a retired row's bytes
  // through the session that replaced it is how a closed gate still emits a
  // write, and how one account's layout reaches another's (davetho review,
  // PR #7081). `orgId` belongs here even though the selector never carries it:
  // the server row is unique on the organization the session resolves to, so a
  // switch is a different row (marisolashgrove review, PR #7081).
  const latestRowRef = useRef({ active, orgId, selector, storageKey });
  latestRowRef.current = { active, orgId, selector, storageKey };

  const deliver = useCallback((serialized: string) => {
    seqRef.current += 1;
    setInbound({ seq: seqRef.current, serialized });
  }, []);

  const publish = useCallback(
    (serialized: string) => {
      const sync = syncRef.current;
      if (!active || canonicalJsonString(serialized) === sync.confirmed) {
        return;
      }
      sync.pending = serialized;
      clearPendingTimer(sync);
      sync.timer = setTimeout(
        () => publishNow(syncRef.current),
        GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS
      );
    },
    [active]
  );

  useEffect(() => {
    // A new selector is a different row, so nothing the previous one confirmed
    // may be carried into it — least of all its revision, which would make the
    // first write a compare-and-swap against another row's history. The context
    // rides ON the state rather than in this closure, so a flush always writes
    // the row whose bytes it is holding, even when it runs from the cleanup
    // after a newer selector has taken over the hook.
    const sync = newSyncState();
    syncRef.current = sync;
    setInbound(null);
    if (!(active && selector && storageKey)) {
      return;
    }
    sync.context = { clientRef, deliver, selector, storageKey };
    beginAdoption(sync);
    return () => {
      const latest = latestRowRef.current;
      const replaced =
        latest.active !== active ||
        latest.orgId !== orgId ||
        latest.selector !== selector ||
        latest.storageKey !== storageKey;
      if (replaced) {
        // Not an unmount: the gate closed, the account or organization changed,
        // or the scope moved. The buffered bytes belong to the row being
        // retired, and there is no session left that may write them, so they go
        // with it.
        discardPending(sync);
      } else {
        // Send what the debounce is still holding BEFORE retiring this row. An
        // in-app navigation unmounts the grid; without this, it would strand the
        // reader's last change on this device, where the next mount's
        // adopt-the-server rule would replace it.
        flushSync(sync);
      }
      // Set after, so the answer to an in-flight write can still be recorded but
      // can no longer move a screen this row no longer owns.
      sync.cancelled = true;
    };
  }, [active, deliver, orgId, selector, storageKey]);

  return useMemo(
    () => ({ inbound: active ? inbound : null, publish }),
    [active, inbound, publish]
  );
}

const CONFLICT_STATUS = 409;

/** What a flush needs to reach the right row, independent of any closure. */
type GridPreferenceSyncContext = {
  /**
   * The live API client, read at USE time and never captured. Desktop replaces
   * the object on every access-token refresh while the account behind it is
   * unchanged, so a captured one pins this row's requests to a client the
   * surface has already retired (marisolashgrove review, PR #7081).
   */
  clientRef: { readonly current: ApiClient | null };
  selector: GridPreferenceSelector;
  /** Where the surface's own copy lives, for the seeding read on adoption. */
  storageKey: string;
  deliver: (serialized: string) => void;
};

/**
 * The mutable bookkeeping for ONE selector's sync: the CAS token the server last
 * issued, the canonical bytes it confirmed, the debounced write not yet sent,
 * and whether this row has been superseded. Held in one object so a selector
 * change replaces the whole set atomically instead of resetting five refs.
 */
type GridPreferenceSyncState = {
  /** Null until the read for this row starts; a flush before then sends nothing. */
  context: GridPreferenceSyncContext | null;
  /**
   * Whether the authoritative first read has SETTLED for this row. Until it
   * has, a write has no revision to compare against, so it is not a
   * compare-and-swap at all — it is an unconditional overwrite of whatever the
   * account holds, issued by a screen that has not yet seen it. `publish`
   * therefore only buffers until this flips (whitlockk review, PR #7081), and a
   * read that never landed leaves it false until a later publish retries that
   * read ({@link beginAdoption}): still never a blind write, but no longer a row
   * pinned read-only for the life of the mount (marisolashgrove review, PR #7081).
   */
  adopted: boolean;
  /**
   * Whether a write is out. At most one ever is, which is what gives the writes
   * an order: a second edit cannot reuse the revision the first is about to
   * replace, and its answer cannot arrive against a layout that has already
   * been superseded. Whatever queued behind the in-flight write goes out from
   * its own resolve (whitlockk review, PR #7081).
   */
  inFlight: boolean;
  revision: number | null;
  /** Confirmed bytes in {@link canonicalJsonString} form, for comparison. */
  confirmed: string | null;
  /** The same confirmed record as written bytes, for a rollback to deliver. */
  confirmedSerialized: string | null;
  pending: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
};

function newSyncState(): GridPreferenceSyncState {
  return {
    adopted: false,
    cancelled: false,
    confirmed: null,
    confirmedSerialized: null,
    context: null,
    inFlight: false,
    pending: null,
    revision: null,
    timer: null,
  };
}

/**
 * Send whatever the debounce is holding for THIS row, now.
 *
 * Takes the whole sync state rather than a closure, so the timer and the
 * unmount cleanup both write the row the bytes belong to. A row unmounted with
 * a write already out still finishes it — the reader made that change and would
 * miss it — but stops being allowed to move the screen once `cancelled` is set.
 * The other cleanup, the one an identity change runs, never reaches here: it
 * discards instead, because its bytes belong to a row that is going away.
 *
 * HOLDS rather than drops when the row is not writable yet: before the first
 * read has settled there is no revision to write against, and while a write is
 * out a second one would race it. Both cases leave `pending` in place, and both
 * re-enter here the moment they clear — {@link settleAdoption} and the resolve
 * below.
 */
function flushSync(sync: GridPreferenceSyncState): void {
  const context = sync.context;
  if (context === null || !(sync.adopted && !sync.inFlight)) {
    return;
  }
  const client = context.clientRef.current;
  if (client === null) {
    // Signed out mid-row. Hold the bytes: the cleanup that retires this row is
    // what decides whether they are sent or discarded, not this flush.
    return;
  }
  const bytes = sync.pending;
  sync.pending = null;
  clearPendingTimer(sync);
  if (bytes === null) {
    return;
  }
  const value = parseJsonObject(bytes);
  if (value === null) {
    // Bytes this hook did not author. Refuse rather than guess.
    return;
  }
  // The cap is the SERVER's, so it is measured on the body about to be posted,
  // not on the bytes as the surface serialized them. Refuse rather than trim: a
  // truncated layout is a layout the reader never chose.
  if (!isWithinGridPreferenceValueCap(JSON.stringify(value))) {
    return;
  }
  if (canonicalJsonString(bytes) === sync.confirmed) {
    // Already the account's layout — a write buffered across adoption that the
    // adoption itself went on to store.
    return;
  }
  sync.inFlight = true;
  writePreference({
    client,
    expectedRevision: sync.revision,
    selector: context.selector,
    value,
  }).then((outcome) => {
    sync.inFlight = false;
    settleWrite({ bytes, context, outcome, sync });
    flushSync(sync);
  });
}

/**
 * Record, recover from, or report the answer to one write.
 *
 * Silent when a NEWER layout is already queued: that answer describes bytes
 * nobody is looking at any more, so rolling the screen back to them would undo
 * an edit the reader has since made, and a conflict message would name a
 * comparison the queued write is about to redo.
 */
function settleWrite(input: {
  sync: GridPreferenceSyncState;
  context: GridPreferenceSyncContext;
  outcome: RemoteWriteOutcome;
  bytes: string;
}): void {
  const { sync, context, outcome, bytes } = input;
  if (outcome.status === "stored") {
    recordConfirmed(sync, outcome.revision, bytes);
    return;
  }
  if (sync.cancelled || sync.pending !== null) {
    return;
  }
  if (outcome.status === "conflict") {
    recoverFromConflict(sync, context);
    return;
  }
  rollBack(sync.confirmedSerialized, context.deliver);
}

/**
 * Answer a rejected compare-and-swap by asking what the row actually holds now.
 *
 * Deliberately NOT the mount-time adoption: that path may IMPORT the local
 * record when the server holds none, and here "holds none" means the writer
 * that beat us DELETED the row — importing would resurrect it from the very
 * bytes the server just refused. So this reads, and either shows the
 * authoritative record or falls back to the last layout this session confirmed;
 * it never writes (davetho review, PR #7081).
 */
function recoverFromConflict(
  sync: GridPreferenceSyncState,
  context: GridPreferenceSyncContext
): void {
  const { clientRef, selector, deliver } = context;
  const client = clientRef.current;
  if (client === null) {
    return;
  }
  readPreference(client, selector).then((remote) => {
    if (sync.cancelled) {
      return;
    }
    if (remote !== null && remote.status === "found") {
      const serialized = JSON.stringify(remote.value);
      recordConfirmed(sync, remote.revision, serialized);
      toast.info(GRID_PREFERENCE_CONFLICT_MESSAGE);
      deliver(serialized);
      return;
    }
    // The row is gone, or the re-read did not land either. There is no
    // authoritative record to show and none to compare against, so drop the
    // stale token — a LATER edit the reader makes then recreates the row
    // instead of colliding with a revision nothing has — and put the screen on
    // the last layout this session confirmed, or say the write failed.
    sync.revision = null;
    rollBack(sync.confirmedSerialized, deliver);
  });
}

/** The authoritative read has answered: held writes may go out. */
function settleAdoption(sync: GridPreferenceSyncState): void {
  sync.adopted = true;
  flushSync(sync);
}

function discardPending(sync: GridPreferenceSyncState): void {
  sync.pending = null;
  clearPendingTimer(sync);
}

function clearPendingTimer(sync: GridPreferenceSyncState): void {
  if (sync.timer !== null) {
    clearTimeout(sync.timer);
    sync.timer = null;
  }
}

function recordConfirmed(
  sync: GridPreferenceSyncState,
  revision: number,
  serialized: string
): void {
  sync.revision = revision;
  sync.confirmedSerialized = serialized;
  sync.confirmed = canonicalJsonString(serialized);
}

type RemoteWriteOutcome =
  | { status: "stored"; revision: number }
  | { status: "conflict" }
  | { status: "failed" };

/**
 * Read the authoritative row, validated at the trust boundary.
 *
 * `null` means the answer never arrived or did not parse — distinct from
 * `missing`, which is the server stating it holds no row. Conflating the two
 * would make a failed read look like a fresh account and import over whatever
 * the server actually has.
 */
async function readPreference(
  client: ApiClient,
  selector: GridPreferenceSelector
): Promise<GridPreferenceRemoteState | null> {
  try {
    const query = new URLSearchParams({ ...selector }).toString();
    const response = await client.get<unknown>(
      `${GRID_PREFERENCE_ROUTE}?${query}`
    );
    const parsed = gridPreferenceReadResponseSchema.safeParse(response);
    if (!parsed.success) {
      return null;
    }
    if (parsed.data.status === GridPreferenceReadStatus.Found) {
      return {
        revision: parsed.data.preference.revision,
        status: "found",
        value: parsed.data.preference.value,
      };
    }
    if (parsed.data.status === GridPreferenceReadStatus.Missing) {
      return { status: "missing" };
    }
    // A `list` answer to a full selector is a contract this build does not
    // recognize; no answer, rather than an empty row.
    return null;
  } catch {
    return null;
  }
}

async function writePreference(input: {
  client: ApiClient;
  selector: GridPreferenceSelector;
  value: Record<string, unknown>;
  expectedRevision: number | null;
}): Promise<RemoteWriteOutcome> {
  const { client, selector, value, expectedRevision } = input;
  try {
    const response = await client.post<unknown>(GRID_PREFERENCE_ROUTE, {
      ...selector,
      value,
      ...(expectedRevision === null ? {} : { expectedRevision }),
    });
    const parsed = gridPreferenceUpsertResponseSchema.safeParse(response);
    return parsed.success
      ? { revision: parsed.data.preference.revision, status: "stored" }
      : { status: "failed" };
  } catch (error) {
    return isRevisionConflict(error)
      ? { status: "conflict" }
      : { status: "failed" };
  }
}

function isRevisionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === CONFLICT_STATUS
  );
}

/**
 * Put the view back on the last layout the server confirmed, and say so.
 *
 * Only the axes in the failed batch move: the confirmed bytes are the WHOLE
 * previous record, so every other axis, every carried unknown column id, and
 * every other grid's row are exactly where they were. With no confirmed bytes
 * there is no authoritative layout to return to — the local write still
 * succeeded, so the reader keeps what they chose and is told the account copy
 * did not save, rather than having the change silently undone.
 */
function rollBack(
  confirmedSerialized: string | null,
  deliver: (serialized: string) => void
): void {
  if (confirmedSerialized === null) {
    toast.error(GRID_PREFERENCE_WRITE_FAILED_MESSAGE);
    return;
  }
  toast.error(GRID_PREFERENCE_ROLLBACK_MESSAGE);
  deliver(confirmedSerialized);
}

function readRawStoredValue(key: string): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Carry out the adoption plan for one selector: take the server's layout, or
 * seed the row from the local one. The local record is left in place either way.
 */
function runAdoption(input: {
  context: GridPreferenceSyncContext;
  remote: GridPreferenceRemoteState;
  sync: GridPreferenceSyncState;
}): void {
  const { context, remote, sync } = input;
  const { clientRef, deliver, selector, storageKey } = context;
  const plan = planGridPreferenceAdoption({
    localRaw: readRawStoredValue(storageKey),
    remote,
  });
  if (plan.kind === "adopt") {
    recordConfirmed(
      sync,
      remote.status === "found" ? remote.revision : 1,
      plan.serialized
    );
    // Anything `publish` buffered while the read was in flight describes the
    // layout this delivery is about to replace on screen. Sending it would put
    // the account on a layout the reader is no longer looking at, which is the
    // adopt-the-server rule inverted, so it goes with the layout it described.
    discardPending(sync);
    settleAdoption(sync);
    deliver(plan.serialized);
    return;
  }
  if (plan.kind !== "import") {
    // Nothing local worth seeding. The row stays absent and the next edit
    // creates it, so held writes are released rather than dropped.
    settleAdoption(sync);
    return;
  }
  const client = clientRef.current;
  if (client === null) {
    settleAdoption(sync);
    return;
  }
  const serialized = JSON.stringify(plan.value);
  // Through the same in-flight lock as every other write: the import IS this
  // row's first write, and a change made during the read must queue behind it
  // rather than race it for the row that does not exist yet.
  sync.inFlight = true;
  writePreference({
    client,
    expectedRevision: null,
    selector,
    value: plan.value,
  }).then((outcome) => {
    sync.inFlight = false;
    if (outcome.status === "stored") {
      recordConfirmed(sync, outcome.revision, serialized);
    }
    settleAdoption(sync);
  });
}

/**
 * Read the account's copy for this row and act on the answer.
 *
 * Runs on mount, and again from {@link publishNow} when that read never landed.
 * One failed GET used to pin the row read-only for the life of the mount, with
 * no retry: on a desktop Sessions view that can stay mounted for days, a launch
 * while offline stopped the account copy updating until the reader navigated
 * away and back (marisolashgrove review, PR #7081). Held under the same `inFlight`
 * lock as a write, so a burst of edits starts at most one read and no write can
 * go out against a revision this read is about to establish.
 */
function beginAdoption(sync: GridPreferenceSyncState): void {
  const context = sync.context;
  if (context === null || sync.adopted || sync.inFlight) {
    return;
  }
  const client = context.clientRef.current;
  if (client === null) {
    return;
  }
  sync.inFlight = true;
  readPreference(client, context.selector).then((remote) => {
    sync.inFlight = false;
    if (sync.cancelled) {
      return;
    }
    if (remote === null) {
      // The read never landed (offline, 401, 5xx) or did not parse. Degrade to
      // the local store rather than guess at a layout, and leave the row
      // untouched — a failed read is not an empty account. Anything `publish`
      // buffered STAYS buffered for the next publish to retry this read with,
      // and is never sent with no revision, which is the blind overwrite the
      // read exists to prevent. Bytes already waiting are an edit that has NOT
      // reached the account, so say so rather than let it look saved.
      if (sync.pending !== null) {
        toast.error(GRID_PREFERENCE_WRITE_FAILED_MESSAGE);
      }
      return;
    }
    runAdoption({ context, remote, sync });
  });
}

/**
 * The debounce fired for this row: send what it is holding.
 *
 * Before the account's copy has been read there is no revision to write
 * against, so this is also where a read that never landed is retried —
 * demand-driven, at most one at a time, and only while the reader is still
 * making changes. The unmount cleanup deliberately calls {@link flushSync}
 * directly instead: a row being retired has nowhere to put a read's answer.
 */
function publishNow(sync: GridPreferenceSyncState): void {
  if (sync.adopted) {
    flushSync(sync);
    return;
  }
  beginAdoption(sync);
}
