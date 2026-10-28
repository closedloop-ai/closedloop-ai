/**
 * Length bounds for compute-target and desktop-command fields that reach a
 * Postgres column or an HTTP header.
 *
 * These live in `lib/` rather than beside the REST validator because
 * `machine_name` has THREE producers — the REST validators, the relay hello
 * handler, and the desktop gateway wire schema — and one of them
 * (`lib/desktop-gateway-wire.ts`) may not import from `app/`.
 *
 * Every value here is derived from something already in the repo or from the
 * sink it protects. None is picked.
 */

/**
 * `compute_targets.machine_name` carries `@@unique([userId, machineName])`, a
 * btree unique index, so an oversized value raises SQLSTATE 54000 at INSERT
 * rather than being truncated. 120 is not a new bound — it is the one
 * `registerComputeTargetValidator` has always enforced, hoisted here so the two
 * socket lanes stop disagreeing with it.
 */
export const MACHINE_NAME_MAX_LENGTH = 120;

/** Linux `PATH_MAX`. */
export const ALLOWED_DIRECTORY_MAX_LENGTH = 4096;

/**
 * `desktop_commands.operation_id` carries a UNIQUE partial btree, so an
 * oversized value raises SQLSTATE 54000. Lives here rather than beside the REST
 * validator because `LOCK_KEY_MAX_LENGTH` is derived from it and `lib/` must not
 * import from `app/`.
 */
export const OPERATION_ID_MAX_LENGTH = 200;

/**
 * Derived from the shape that PRODUCES a lock key, not from a neighbouring
 * column bound.
 *
 * `idempotencyKey`'s 200 is justified by a UNIQUE partial btree on its own
 * column; `lockKey` has no column at all — it lives inside the `request_payload`
 * Json blob — so there is no index-row limit to borrow. What does bound it is
 * its composition: the desktop builds `${operationId}:${scopedPath}`, where
 * `operationId` is already allowed `OPERATION_ID_MAX_LENGTH` and `scopedPath`
 * is an absolute filesystem path. Sizing this at 200 would have refused an
 * ordinary lock key.
 */
export const LOCK_KEY_MAX_LENGTH =
  OPERATION_ID_MAX_LENGTH + 1 + ALLOWED_DIRECTORY_MAX_LENGTH;

/**
 * A human sentence shown in the desktop approval dialog that ALSO becomes the
 * `x-desktop-approval-reason` header value, so it has to stay far below the
 * conventional 8 KB header limit.
 */
export const APPROVAL_REASON_MAX_LENGTH = 1000;

/**
 * The JSON of `{commandId, method, path, query, bodyHash, timestamp, nonce}`.
 *
 * Derived from the transport, not a convention: the same string also travels as
 * the `COMMAND_SIGNATURE_PAYLOAD_HEADER` HTTP header on the web surface, so a
 * payload past the usual 8 KB header budget already fails there. The request
 * body appears only as a HASH, so nothing inside it can push past that.
 */
export const SIGNATURE_PAYLOAD_MAX_LENGTH = 8192;

/** Gateway operation ids are short dotted identifiers. */
export const SUPPORTED_OPERATION_MAX_LENGTH = 200;

/** An order of magnitude above any real gateway operation set. */
export const SUPPORTED_OPERATIONS_MAX_COUNT = 500;

/** Same headroom rationale as the operation count. */
export const ALLOWED_DIRECTORIES_MAX_COUNT = 500;

/**
 * True when `value` fits the machine-name bound.
 *
 * The RAW length is what is measured, because the raw string is what these
 * lanes PERSIST: neither socket lane trims, and `computeTargetsService` does no
 * trimming of its own, so the raw value is what reaches the
 * `@@unique([userId, machineName])` btree. Measuring `value.trim().length`
 * here — which this helper did first — bounded a string nobody stores: 120
 * characters followed by several kilobytes of spaces passed the check and still
 * raised SQLSTATE 54000 at INSERT, which is the whole handshake-loop failure
 * this guard exists to prevent.
 *
 * Still no `.trim()` at the call sites. Bounding what is stored and REWRITING
 * what is stored are different things, and only the first is invalid-input-only
 * — trimming would change the persisted bytes of a padded name that fits.
 *
 * This is deliberately stricter than the REST validator, which trims BEFORE it
 * caps and so stores at most 120 characters from a longer raw input. Each lane
 * bounds the value it actually writes; that is the invariant, not a shared
 * spelling.
 */
export function isWithinMachineNameLimit(value: string): boolean {
  return value.length <= MACHINE_NAME_MAX_LENGTH;
}

/**
 * Code points an approval reason may not contain.
 *
 * Deliberately NOT "printable ASCII". `approvalReason` is caller-authored prose
 * rendered in the desktop approval dialog, so refusing every non-English reason
 * would reject valid input. Only two classes are genuinely broken:
 *
 * - **Above U+00FF.** The reason becomes the `x-desktop-approval-reason` header
 *   value, and `Headers.set` throws a `TypeError` on any code point a ByteString
 *   cannot hold — so those inputs already crash the consumer today.
 * - **C0 controls and DEL, except HTAB.** Header injection. `\u0009` is excluded
 *   from the refusal because a horizontal tab is a legal HTTP field-value
 *   character, so rejecting it would not be invalid-input-only.
 *
 * `é`, `ü`, `ñ` are all at or below U+00FF and pass.
 */
/** Highest code point an HTTP header value can carry (WebIDL ByteString). */
const LATIN_1_MAX_CODE_POINT = 0xff;
/** Highest C0 control. */
const C0_MAX_CODE_POINT = 0x1f;
/** DEL. */
const DEL_CODE_POINT = 0x7f;
/** Horizontal tab — a C0 control, but a legal HTTP field-value character. */
const HTAB_CODE_POINT = 0x09;

/** True when `value` can be carried in an HTTP header without throwing. */
export function isHeaderSafeReason(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > LATIN_1_MAX_CODE_POINT || codePoint === DEL_CODE_POINT) {
      return false;
    }
    if (codePoint <= C0_MAX_CODE_POINT && codePoint !== HTAB_CODE_POINT) {
      return false;
    }
  }
  return true;
}

/**
 * True when every declared gateway operation, and the declaration's size, fit
 * their bounds.
 *
 * A predicate rather than a truncation. Silently keeping a prefix of an
 * oversized declaration stores an INCOMPLETE capability set that the hello then
 * acknowledges, and downstream gates read it with
 * `supportedOperations.includes(...)` — so every operation past the cutoff is
 * reported as unsupported by a desktop that supports it, and the desktop is
 * never told. A refused hello is a visible, retryable failure; a silently
 * truncated one is a wrong answer the caller cannot see.
 */
export function isWithinSupportedOperationsLimits(
  operations: readonly string[]
): boolean {
  return (
    operations.length <= SUPPORTED_OPERATIONS_MAX_COUNT &&
    operations.every(
      (operation) => operation.length <= SUPPORTED_OPERATION_MAX_LENGTH
    )
  );
}

/**
 * The approval reason a relay `params` blob may carry, or `undefined`.
 *
 * `createDesktopCommandValidator` bounds this field on the REST route, but the
 * relay wire mapper reads it from `RelayOperationDispatchRequest.params`, an
 * unvalidated `JsonValue`, so an unbounded or non-latin-1 reason would only fail
 * at the desktop, where `Headers.set` throws a `TypeError` on the
 * `x-desktop-approval-reason` value and takes the whole command with it.
 *
 * Dropping the field rather than refusing the dispatch is the same degradation
 * `timeoutMs` already takes in the wire mapper: the reason is advisory prose, the
 * command is not, and a version-skewed peer must not lose a command over one
 * malformed advisory field. Absence is honest here — it is the one thing that
 * cannot be mistaken for a reason the caller wrote.
 */
export function sanitizeApprovalReason(
  value: unknown,
  onRejected: (rejection: { reason: string }) => void
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.length > APPROVAL_REASON_MAX_LENGTH) {
    onRejected({ reason: "too_long" });
    return undefined;
  }
  if (!isHeaderSafeReason(value)) {
    onRejected({ reason: "not_header_safe" });
    return undefined;
  }
  return value;
}
