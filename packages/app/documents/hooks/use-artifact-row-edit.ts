"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactStatus, Document } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { transformApiUserToSelectUser } from "@repo/app/shared/lib/user-utils";
import { useCommitLedger } from "@repo/design-system/components/ui/use-commit-ledger";
import type { User as PopoverUser } from "@repo/design-system/components/ui/user-select-popover";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * What a surface must supply to make an artifact row's status, assignee and
 * priority editable. Omit it and every field below reports the artifact's own
 * value with no commit callback, which is how `ArtifactRowView` decides to
 * render the row read-only.
 */
export type ArtifactRowEditController = Readonly<{
  /**
   * Org members the assignee picker offers, or `undefined` while the roster is
   * loading — or after it FAILED. Only the assignee picker depends on it:
   * status and priority need nothing but the commit callback, so withholding
   * the whole controller until the roster lands would make two fields that
   * never wanted it inert for the page's lifetime on a failed `/users` read.
   */
  users?: readonly BasicUser[];
  /**
   * Performs the write. MUST reject when the server refuses, because that
   * rejection is the only thing that puts the refused value back on screen —
   * resolve a failed write and the row keeps showing something that was never
   * saved. `mutateAsync` satisfies this; `mutate` does not.
   */
  commit: (input: ArtifactRowEditInput) => Promise<unknown>;
}>;

export type ArtifactRowEditInput = Readonly<{
  /** The artifact being written. One controller serves every row in a list. */
  id: string;
  status?: ArtifactStatus;
  /**
   * ISS-9443: where the write came from. Set by this hook, not by the surface —
   * every row that goes through it IS an inline cell, so leaving the value to
   * each caller would only create ways for one of them to disagree.
   */
  surface?: ArtifactStatusEditSurface;
  /** ISS-9665: `null` clears the priority; omitted leaves it untouched. */
  priority?: Priority | null;
  assigneeId?: string | null;
  /** ISS-11198: the assignee the server last confirmed, as the write's guard. */
  expectedAssigneeId?: string | null;
}>;

export type ArtifactRowEditState = Readonly<{
  /** What the row must render — the optimistic value while a commit is in flight. */
  status: ArtifactStatus;
  /** ISS-9665: `null` is "no priority" — a real state, not a failed read. */
  priority: Priority | null;
  /**
   * ISS-9307: a priority write is in flight. The row shows the optimistic value
   * either way; this is what lets the mark say so, rather than looking settled
   * while the server has not answered.
   *
   * Priority only. Status and assignee have no consumer for it, and a flag they
   * emit but nothing reads is the unreachable code the champion's own contract
   * forbids.
   */
  priorityPending: boolean;
  assignee: BasicUser | null;
  /**
   * Popover options. Absent when the row is read-only, and also when the row
   * IS editable but the org roster has not arrived — the two other fields stay
   * live in that second case, so this is no longer a proxy for "read-only".
   */
  users?: PopoverUser[];
  onStatusChange?: (status: ArtifactStatus) => void;
  onPriorityChange?: (priority: Priority | null) => void;
  onAssigneeChange?: (assigneeId: string | null) => void;
}>;

/**
 * Optimistic status/assignee/priority editing for one artifact row.
 *
 * The whole point is the REFUSED write. A row that keeps showing a value the
 * server rejected is worse than a row that was never editable, so each field
 * runs through {@link useCommitLedger} — the same out-of-order ledger the
 * design system's inline cells use — which puts back the newest value that was
 * not refused rather than blindly restoring whatever this row started with.
 *
 * The failure MESSAGE is deliberately not raised here. The shared QueryClient's
 * default `mutations.onError` already toasts every rejected mutation, so a
 * second message for the same failure would be the one thing this row does not
 * need. Rollback and toast are independent, and the row owes the reader both.
 *
 * The ledger is string-keyed, so an absent assignee travels as `""` and is
 * mapped back to `null` at the commit boundary — the API distinguishes the two
 * (`assigneeId: null` unassigns) and `""` is not a uuid it would accept. ISS-9665
 * puts an unset PRIORITY through that same sentinel for the same reason: `null`
 * clears it server-side and is not a value the string-keyed ledger can hold.
 */
export function useArtifactRowEdit(
  artifact: Document,
  controller?: ArtifactRowEditController
): ArtifactRowEditState {
  const committedAssigneeId = artifact.assigneeId ?? "";

  const committedPriority = artifact.priority ?? UNSET_PRIORITY;

  const [status, setStatus] = useState<ArtifactStatus>(artifact.status);
  const [priority, setPriority] = useState<Priority | null>(artifact.priority);
  const [assigneeId, setAssigneeId] = useState<string>(committedAssigneeId);
  // A COUNT, not a boolean: two quick picks overlap, and a boolean cleared by
  // the first to settle would report the row idle while the second is still out.
  const [priorityWritesInFlight, setPriorityWritesInFlight] = useState(0);

  const serialize = useFieldWriteQueue();
  const statusLedger = useCommitLedger(artifact.status);
  const priorityLedger = useCommitLedger(committedPriority);
  const assigneeLedger = useCommitLedger(committedAssigneeId);
  // ISS-11198: the assignee the server last confirmed, read when a write is
  // ISSUED. The field's queue has settled every earlier pick by then, so this
  // is never the optimistic value the row shows, and a pick queued behind an
  // accepted one expects that one rather than the value the cache still holds.
  const confirmedAssigneeIdRef = useRef(committedAssigneeId);

  // A refetch (or another user's edit) is authoritative: it replaces what is on
  // screen and outranks every commit in flight, so a rejection arriving
  // afterwards can no longer roll it back to this row's optimistic value.
  useEffect(() => {
    statusLedger.reset(artifact.status);
    setStatus(artifact.status);
  }, [artifact.status, statusLedger]);
  useEffect(() => {
    priorityLedger.reset(committedPriority);
    setPriority(artifact.priority);
  }, [artifact.priority, committedPriority, priorityLedger]);
  useEffect(() => {
    assigneeLedger.reset(committedAssigneeId);
    confirmedAssigneeIdRef.current = committedAssigneeId;
    setAssigneeId(committedAssigneeId);
  }, [committedAssigneeId, assigneeLedger]);

  const users = useMemo(
    () => controller?.users?.map(transformApiUserToSelectUser),
    [controller?.users]
  );

  const assignee = useMemo(() => {
    if (!assigneeId) {
      return null;
    }
    if (assigneeId === committedAssigneeId && artifact.assignee) {
      return artifact.assignee;
    }
    // Two shapes reach here and the roster answers both. One is optimistic: the
    // row shows a pick the fetched artifact does not carry yet. The other is
    // deploy skew — a pre-ISS-7732 `/artifact-links/resolved` omits the joined
    // user, and the adapter normalizes that absence to `assignee: null` while
    // PRESERVING `assigneeId`. Returning that `null` unresolved would render an
    // actually-assigned artifact as "Unassigned", which is the row lying about
    // who owns the work.
    return controller?.users?.find((user) => user.id === assigneeId) ?? null;
  }, [assigneeId, committedAssigneeId, artifact.assignee, controller?.users]);

  if (!controller) {
    return {
      status: artifact.status,
      priority: artifact.priority,
      priorityPending: false,
      assignee: artifact.assignee,
    };
  }

  const { commit } = controller;
  const id = artifact.id;
  return {
    status,
    priority,
    priorityPending: priorityWritesInFlight > 0,
    assignee,
    onStatusChange: (next) => {
      setStatus(next);
      // The ledger settles on a plain string; every value it can hand back is
      // one this row submitted, so the rollback re-narrows rather than parses.
      statusLedger.submit(
        next,
        () =>
          serialize(ArtifactRowField.Status, () =>
            commit({
              id,
              status: next,
              surface: ArtifactStatusEditSurface.InlineCell,
            })
          ),
        (resolved) => setStatus(resolved as ArtifactStatus)
      );
    },
    onPriorityChange: (next) => {
      setPriority(next);
      priorityLedger.submit(
        next ?? UNSET_PRIORITY,
        () => {
          // Raised and lowered in one expression, because nothing else ever
          // lowers this count: a row that kept the mark raised after the write
          // settled would stay busy and dimmed for the rest of its life.
          // `serialize` is what makes that pairing safe against a `commit` that
          // throws synchronously — it hands the call to `tail.then(run, run)`,
          // so `commit` is never reached before the promise the `.finally` hangs
          // off already exists. The row's own suite pins that outcome.
          setPriorityWritesInFlight((count) => count + 1);
          return serialize(ArtifactRowField.Priority, () =>
            commit({
              id,
              priority: next,
              surface: ArtifactStatusEditSurface.InlineCell,
            })
          ).finally(() => {
            setPriorityWritesInFlight((count) => count - 1);
          });
        },
        (resolved) =>
          setPriority(
            resolved === UNSET_PRIORITY ? null : (resolved as Priority)
          )
      );
    },
    // Only the picker needs the roster. Status and priority above are already
    // live without it, and handing back `onAssigneeChange` with no options
    // would be worse than withholding it: `ArtifactRow` reads that handler as
    // "the avatar is a picker trigger" and makes the avatar decorative and
    // unlinked, so the row would lose the assignee's name AND their profile
    // link in exchange for a control that cannot open.
    ...(users && {
      users,
      onAssigneeChange: (next: string | null) => {
        setAssigneeId(next ?? "");
        assigneeLedger.submit(
          next ?? "",
          () =>
            serialize(ArtifactRowField.Assignee, () =>
              commit({
                id,
                assigneeId: next,
                expectedAssigneeId: confirmedAssigneeIdRef.current || null,
              }).then((result) => {
                confirmedAssigneeIdRef.current = next ?? "";
                return result;
              })
            ),
          setAssigneeId
        );
      },
    }),
  };
}

/** The three independently-committed fields, each with its own write queue. */
const ArtifactRowField = {
  Status: "status",
  Priority: "priority",
  Assignee: "assignee",
} as const;
type ArtifactRowField =
  (typeof ArtifactRowField)[keyof typeof ArtifactRowField];

/**
 * The string-keyed ledger's stand-in for "no priority" (ISS-9665). Same device
 * the assignee field already uses for "unassigned": the ledger settles on plain
 * strings, so a `null` cannot travel through it, and `""` is not a value the
 * Priority vocabulary can ever contain.
 */
const UNSET_PRIORITY = "";

const RESOLVED: Promise<unknown> = Promise.resolve();
const IGNORE = () => {
  // The queue tail only orders the NEXT write; the real outcome is the promise
  // handed back to the ledger, which is where a rejection belongs.
};

/**
 * One in-flight write per field, per row.
 *
 * {@link useCommitLedger} orders what the row DISPLAYS, and that is all it can
 * do — it never sees the network. Two quick picks on the same field otherwise
 * issue two independent PUTs, and nothing makes the server apply them in the
 * order the user made them: `Done` can land before `In Progress` and then be
 * overwritten by it, so the row shows `Done`, the database holds `In Progress`,
 * and the next invalidation silently flips the row back to a value the user
 * had already replaced.
 *
 * Chaining is what removes that race: the second write is not ISSUED until the
 * first has settled, so the order the server sees is the order the user chose.
 * A failure does not wedge the queue — the chain continues from either
 * settlement — and the caller still receives the true result of its own write,
 * because the swallowing `IGNORE` is applied to the stored tail and not to what
 * is returned.
 *
 * Per FIELD rather than per row: an assignee pick has no reason to wait behind
 * an unrelated status write, and serializing them together would make the row
 * feel slower with nothing bought for it.
 */
function useFieldWriteQueue(): (
  field: ArtifactRowField,
  run: () => Promise<unknown>
) => Promise<unknown> {
  const tails = useRef(new Map<ArtifactRowField, Promise<unknown>>());
  return useCallback((field, run) => {
    const tail = tails.current.get(field) ?? RESOLVED;
    const next = tail.then(run, run);
    tails.current.set(field, next.then(IGNORE, IGNORE));
    return next;
  }, []);
}
