/**
 * @file storage-exhaustion.ts
 * @description ISS-6337 — classify a DISK-FULL write failure at the desktop
 * store's write boundary, and tally it for the monitored store-integrity event.
 *
 * Before this, `SQLITE_FULL`/`ENOSPC` appeared nowhere in `apps/desktop/src`: a
 * customer whose disk filled during the first-launch import got writes that
 * failed with no classification and no signal, and every best-effort write
 * launched with `void` took the whole app down through
 * `handleUnhandledRejection`. Remotely the install was indistinguishable from a
 * healthy one.
 *
 * Deliberately free of `zod` and of the store-integrity probe graph: this module
 * is on the WRITE path (`prisma-client.ts`) and on the boot-adjacent
 * fire-and-forget path (`db-host/db-host-fire-and-forget.ts`). The wire
 * boundary and the probe wiring live in the sibling
 * `storage-exhaustion-integrity.ts`, mirroring how `store-integrity-reads.ts`
 * is split from the check modules that consume it.
 *
 * ## Where the result code actually lives
 *
 * The engine reports code 13, but WHERE it survives depends on the call shape,
 * and neither shape puts it on the thrown error itself (verified against the
 * real engine — see `test/storage-exhaustion-monitored.test.ts`):
 *
 *   - a TYPED delegate write throws `DriverAdapterError`, whose `cause` is
 *     `{ kind: "sqlite", extendedCode: 13, … }`;
 *   - a RAW `$executeRawUnsafe` throws `PrismaClientKnownRequestError` with
 *     `code: "P2010"`, no `cause` at all, and the driver error buried at
 *     `meta.driverAdapterError.cause`.
 *
 * So the walk follows both link shapes.
 *
 * ## Why message text is never evidence
 *
 * The verdict is made from RESULT CODES ONLY. An error message is not evidence
 * here, because a message can quote content this process did not author:
 * `recordPackInstallRunEnd` persists a pack-install child's captured
 * `stdout_tail`, and a failed write of that row can echo the parameter back in
 * the Prisma message. A phrase like `no space left on device` sitting in a
 * child's build output would then classify an unrelated write failure as
 * disk-full — and because {@link storageReasonOf} is what
 * `db-host-fire-and-forget.ts` uses to DROP a write instead of crashing, a
 * false positive there silently swallows a real bug. `ENOSPC` is also Linux's
 * inotify watcher-limit errno, which npm and bundlers print routinely.
 *
 * Across the db-host boundary `serializeDbHostError` flattens an error to
 * `{ message, stack, name }`, which is why text used to be the only thing left
 * to read. That is no longer true: the boundary now carries the already-made
 * verdict under {@link STORAGE_EXHAUSTION_REASON_KEY}, classified in the child
 * where the result code still exists, exactly as ISS-4714 carries
 * `refusalKind`. The code therefore survives the boundary, and reading text as
 * a fallback would buy nothing but the false positives above.
 *
 * ## Why the reason is a closed enum and never a string
 *
 * The reason reaches Datadog as a store-integrity issue's `object`. A filesystem
 * error message carries a PATH, and a path carries the OS account name — the
 * exact leak class of ISS-6228 (emails) and ISS-6229 (`file://` install paths).
 * Nothing derived from the error text is ever emitted: only one of three fixed
 * tokens. There is consequently no text to route through
 * `shared/exception-sanitizer.ts`, which is a stronger guarantee than redacting
 * one would be.
 */

/**
 * Why the store could not accept a write, bounded to a closed set. This value —
 * and only this value — is what reaches telemetry, so it must never be widened
 * to carry anything derived from an error message.
 */
export const StorageExhaustionReason = {
  /** SQLite itself refused: result code 13, `SQLITE_FULL`. */
  SqliteFull: "sqlite_full",
  /** The OS refused the underlying file write: `ENOSPC`. */
  Enospc: "enospc",
  /**
   * The store refused a write for lack of space, but this build cannot name the
   * code that says so — the generic fallback. Its one producer is the wire
   * boundary in `storage-exhaustion-integrity.ts`: a version-skewed db host can
   * report a reason token a newer build added, and the alternative to folding it
   * here is dropping a real exhaustion event the child has already consumed.
   */
  Unattributed: "unattributed",
} as const;
export type StorageExhaustionReason =
  (typeof StorageExhaustionReason)[keyof typeof StorageExhaustionReason];

/** Whether an unknown value is one of the three bounded reasons. */
export function isStorageExhaustionReason(
  value: unknown
): value is StorageExhaustionReason {
  return REASON_VALUES.includes(value as StorageExhaustionReason);
}

/**
 * The property under which `serializeDbHostError` carries an already-made
 * verdict across the db-host boundary, and `rebuildError` restores it.
 *
 * Structured clone drops the prototype, so a driver error's result code cannot
 * survive the trip (the same problem ISS-4714 solved for `refusalKind`).
 * Classifying in the CHILD, where the code still exists, and carrying the
 * bounded token is what lets the main side decide without reading message text
 * — see the file header for why text is never evidence.
 */
export const STORAGE_EXHAUSTION_REASON_KEY = "storageExhaustionReason";

/**
 * The storage-exhaustion tally as it crosses the db-host method proxy.
 * Clone-safe (plain scalars) and windowed — see {@link createStorageExhaustionTally}.
 */
export type StorageExhaustionHealth = {
  /** Write failures classified as exhaustion since the previous read. */
  failures: number;
  /** The latched reason, or null once a write has proven the store writable. */
  lastReason: StorageExhaustionReason | null;
  /**
   * Whether the store is still believed full: set by the first classified
   * failure and cleared ONLY by a write that then succeeds. Reading does not
   * clear it — see {@link createStorageExhaustionTally}.
   */
  active: boolean;
};

/** The tally kept next to the write boundary that produced the failures. */
export type StorageExhaustionTally = {
  /**
   * Record one write rejection. Non-exhaustion errors are ignored, so the tally
   * counts only the condition it names — the "increment only inside the branch
   * where its precondition held" rule.
   */
  record(error: unknown): void;
  /**
   * Record one write that SUCCEEDED — the only evidence that the store can
   * accept writes again, and so the only thing that clears the latch.
   */
  recordSuccess(): void;
  /** Consume the failure window; report the latch as it stands. */
  read(): StorageExhaustionHealth;
};

/**
 * Create the write-boundary tally.
 *
 * Bounded by construction: two scalars, one nullable enum and one flag, never a
 * per-error Map, so a store that is full for hours cannot grow this.
 *
 * The COUNT is windowed, for the same reason `readWalProbeHealth`'s is
 * (ISS-4818): a lifetime total would grow without bound and says nothing the
 * per-window count does not.
 *
 * The STATE is not. Windowing it too would mean a probe that read one failure,
 * then read again after an idle interval, reports healthy — and
 * `Observability.storeIntegrityResult` would emit `store.integrity.recovered`
 * off nothing but the passage of time, on a disk that is still full. That is
 * the "never emit a plausible-but-wrong value" rule: not attempting a write is
 * not evidence of recovery. Only a write that SUCCEEDS is, so only
 * {@link StorageExhaustionTally.recordSuccess} clears the latch — and the
 * desktop writes continuously (sync lanes, session ingest), so a cleared disk
 * clears this within one write, not one probe interval.
 */
export function createStorageExhaustionTally(): StorageExhaustionTally {
  let failures = 0;
  let lastReason: StorageExhaustionReason | null = null;
  let active = false;
  return {
    record(error: unknown): void {
      const reason = storageReasonOf(error);
      if (reason === null) {
        return;
      }
      failures += 1;
      lastReason = reason;
      active = true;
    },
    recordSuccess(): void {
      lastReason = null;
      active = false;
    },
    read(): StorageExhaustionHealth {
      const window = { failures, lastReason, active };
      failures = 0;
      return window;
    },
  };
}

/**
 * Classify a write rejection as an out-of-space condition, or `null` when it is
 * anything else (a constraint violation, `SQLITE_BUSY`, a logic bug).
 *
 * This is a TRUST BOUNDARY: the value arrives as `unknown` from a driver, from a
 * structured clone across the db-host boundary, or from a version-skewed peer,
 * so every field is read defensively and an unrecognized shape yields `null`.
 *
 * Only a RESULT CODE (or a verdict already made from one and carried across the
 * db-host boundary) is evidence. Message text is never read — see the file
 * header for the quoted-child-output false positive that rules it out.
 */
export function classifyStorageExhaustion(
  error: unknown
): StorageExhaustionReason | null {
  const pending: unknown[] = [error];
  // Breadth-bounded walk: a driver wraps its cause and Prisma wraps that again,
  // and the visit cap also makes a self-referential `cause` cycle terminate.
  for (let visited = 0; visited < MAX_LINKS_VISITED; visited += 1) {
    const link = pending.shift();
    if (link === undefined) {
      break;
    }
    const code = codeReasonOf(link);
    if (code !== null) {
      return code;
    }
    pending.push(...causeLinksOf(link));
  }
  return null;
}

/**
 * {@link classifyStorageExhaustion}, made TOTAL — the form every caller should
 * use.
 *
 * Both callers run inside a rejection handler whose own promise nothing tracks
 * (the write boundary's, and `dropOnDbHostLifecycleError`'s `work.catch`), and
 * classification reads properties off an arbitrary `unknown`, so a throwing
 * getter or a revoked Proxy is reachable. A throw there would escape as an
 * unhandled rejection — the crash this feature exists to remove — and would
 * additionally replace the REAL failure with the getter's `TypeError`,
 * destroying the evidence a human needs. An unreadable error is simply not an
 * exhaustion verdict.
 */
export function storageReasonOf(
  error: unknown
): StorageExhaustionReason | null {
  try {
    return classifyStorageExhaustion(error);
  } catch {
    return null;
  }
}

/**
 * The LOCAL log line for a best-effort write dropped because the store is full.
 *
 * Carries the bounded reason, never the error text: this line is written to the
 * desktop log file, which is attached to support bundles, and a filesystem error
 * message carries the user's home path.
 */
export function describeStorageExhaustedWrite(
  label: string,
  reason: StorageExhaustionReason
): string {
  return `${label}: dropped because ${REASON_DESCRIPTION[reason]} (${reason}); this write is best-effort and is not replayed`;
}

/**
 * A short, content-free description per reason, for the LOCAL log line.
 *
 * Exhaustive by type: adding a member to {@link StorageExhaustionReason} fails
 * `tsc` here until its wording is decided, rather than silently degrading to a
 * bare token in the one place a human reads this.
 */
const REASON_DESCRIPTION: Record<StorageExhaustionReason, string> = {
  [StorageExhaustionReason.SqliteFull]:
    "SQLite reported the database or disk is full",
  [StorageExhaustionReason.Enospc]:
    "the filesystem reported no space left on device",
  [StorageExhaustionReason.Unattributed]:
    "the store reported an out-of-space condition with no attributable code",
};

/** How many links the classifier inspects before giving up. */
const MAX_LINKS_VISITED = 12;
/** SQLite's primary result code for "database or disk is full". */
const SQLITE_FULL_PRIMARY_CODE = 13;
/** An extended code is `primary + (sub << 8)`, so the primary is `code % 256`.
 *  Written as a modulo because `noBitwiseOperators` is an error in this repo. */
const SQLITE_PRIMARY_CODE_MODULUS = 256;
/** libSQL's base-code string for {@link SQLITE_FULL_PRIMARY_CODE}. */
const SQLITE_FULL_CODE_NAME = "SQLITE_FULL";
/** Node's `error.code` for an out-of-space filesystem write. */
const ENOSPC_CODE_NAME = "ENOSPC";

/** The bounded reasons, as a list, for {@link isStorageExhaustionReason}. */
const REASON_VALUES: readonly StorageExhaustionReason[] = Object.values(
  StorageExhaustionReason
);

/** Read a property without invoking this module's own assumptions about shape. */
function propertyOf(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return Reflect.get(value, key);
}

/**
 * The nested errors worth following from one link: the standard `cause`, plus
 * the Prisma-specific `meta.driverAdapterError.cause` where a RAW query's driver
 * error is buried (a `PrismaClientKnownRequestError` has no `cause` at all).
 */
function causeLinksOf(value: unknown): unknown[] {
  const links: unknown[] = [];
  const cause = propertyOf(value, "cause");
  if (cause !== undefined && cause !== value) {
    links.push(cause);
  }
  const adapterCause = propertyOf(
    propertyOf(propertyOf(value, "meta"), "driverAdapterError"),
    "cause"
  );
  if (adapterCause !== undefined && adapterCause !== value) {
    links.push(adapterCause);
  }
  return links;
}

/** Classify ONE link from its structured result code, ignoring message text. */
function codeReasonOf(value: unknown): StorageExhaustionReason | null {
  // A verdict already made in the db-host child, where the result code still
  // existed, outranks re-deriving one here — see STORAGE_EXHAUSTION_REASON_KEY.
  const carried = propertyOf(value, STORAGE_EXHAUSTION_REASON_KEY);
  if (isStorageExhaustionReason(carried)) {
    return carried;
  }
  const code = propertyOf(value, "code");
  if (code === SQLITE_FULL_CODE_NAME) {
    return StorageExhaustionReason.SqliteFull;
  }
  if (code === ENOSPC_CODE_NAME) {
    return StorageExhaustionReason.Enospc;
  }
  const numeric = [
    propertyOf(value, "rawCode"),
    propertyOf(value, "extendedCode"),
    propertyOf(value, "errcode"),
  ];
  return numeric.some(isSqliteFullCode)
    ? StorageExhaustionReason.SqliteFull
    : null;
}

/**
 * Attach an already-made verdict to a serialized/rebuilt error so the main side
 * can read it without re-deriving one. Writable and non-enumerable: it is
 * carriage, not part of the error's own shape, so it must not appear in a
 * `JSON.stringify` of the error or in a spread of it.
 */
export function attachStorageExhaustionReason(
  error: Error,
  reason: StorageExhaustionReason
): void {
  Object.defineProperty(error, STORAGE_EXHAUSTION_REASON_KEY, {
    value: reason,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/** Whether a candidate result code reduces to SQLite's `SQLITE_FULL`. */
function isSqliteFullCode(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) % SQLITE_PRIMARY_CODE_MODULUS === SQLITE_FULL_PRIMARY_CODE
  );
}
