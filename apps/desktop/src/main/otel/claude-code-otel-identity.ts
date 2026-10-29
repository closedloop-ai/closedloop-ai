/**
 * @file ISS-7352 item F, IDENTITY half — the per-session account and
 * organization identifiers that say WHOSE session a `claude_code_*` row
 * describes.
 *
 * The grain is what separates this from item F's other half. The four
 * per-event join keys are per-RECORD and live in
 * `claude-code-otel-event-correlation.ts`, as columns on the eight
 * event-sourced tables. The attributes below describe the SESSION, so they
 * collapse to one row in `claude_code_session_identity` instead.
 *
 * WHAT IS READ AND WHAT IS NOT. Account and organization identifiers are
 * approved for capture. `user.email` and `user.groups` ride on these same
 * records and are deliberately NOT read — by decision, not by oversight. An
 * identifier is a stable join key; an email address, a handle, or a group
 * membership is a person, and no reader's convenience justifies deriving one
 * into this payload as a label. Keeping the read set a closed literal is what
 * makes that exclusion checkable rather than merely claimed, which is the same
 * reason `claude-code-otel-attributes.ts` states for its own read set.
 *
 * ABSENT STAYS ABSENT. A session that resolves no identifier at all produces
 * no signal and therefore no row: it stays unattributed rather than acquiring a
 * row of NULLs that a reader could mistake for a resolved-but-empty account.
 */

import {
  ClaudeCodeOtelAttributeKey,
  readString,
  withoutUndefinedValues,
} from "./claude-code-otel-attributes.js";
import {
  type ClaudeCodeOtelSideTableSignal,
  ClaudeCodeOtelSignalType,
  type ClaudeCodeSessionIdentitySignal,
} from "./claude-code-otel-signal-contract.js";

/**
 * The identity a single record carries, or `null` if it carries none.
 *
 * `sessionId` alone is not identity — it is the key every other table already
 * has — so a record that resolves nothing but the session produces no signal.
 */
export function sessionIdentitySignalFrom(
  attributes: Record<string, unknown>,
  observedAt: string
): ClaudeCodeSessionIdentitySignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  if (sessionId === undefined) {
    return null;
  }
  const identity = withoutUndefinedValues({
    organizationId: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.OrganizationId
    ),
    userAccountUuid: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.UserAccountUuid
    ),
    userAccountId: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.UserAccountId
    ),
    identitySource: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.IdentitySource
    ),
    terminalType: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.TerminalType
    ),
    appVersion: readString(attributes, ClaudeCodeOtelAttributeKey.AppVersion),
    appEntrypoint: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.AppEntrypoint
    ),
  });
  if (Object.keys(identity).length === 0) {
    return null;
  }
  return {
    type: ClaudeCodeOtelSignalType.SessionIdentity,
    sessionId,
    observedAt,
    ...identity,
  };
}

/**
 * The field-wise UNION of two identity readings of one session — a later
 * reading FILLS a field, it never REWRITES one.
 *
 * Union rather than either whole-record rule, because `organization.id` is only
 * stamped once a session has authenticated: a batch that spans a login carries
 * records without it and later records with it, and taking either record whole
 * drops a field the other genuinely resolved, indistinguishable afterwards from
 * one the producer never stamped.
 *
 * FIRST POPULATED VALUE WINS where both readings resolved the same field and
 * DISAGREE (whitlockk/davetho on #7131). Two different accounts on one session is
 * not a fact the producer reports — it is anomalous — and the previous
 * spread order quietly took the later one, so a single stray record could
 * re-attribute a session that had already been resolved correctly. Keeping the
 * first reading makes the column stable once written and matches what the
 * PERSISTED row does across exports, so the in-batch merge and the upsert state
 * one rule rather than two. It does not make a conflict coherent — a session
 * that genuinely re-authenticates to a different account is a shape this table
 * does not model, and the residual is recorded in `claude-code-otel-identity`'s
 * tests rather than resolved by a tie-break.
 *
 * `observedAt` takes the EARLIER of the two instants, which is the same
 * first-wins rule applied to time and is what makes merging one batch
 * order-independent. Across separate exports the persisted column keeps
 * whichever instant ARRIVED first, because `createSessionIdentityOperation`
 * omits `observedAt` from its conflict clause — a later export carrying an
 * earlier instant does not move it back.
 */
export function mergeSessionIdentity(
  existing: ClaudeCodeSessionIdentitySignal,
  incoming: ClaudeCodeSessionIdentitySignal
): ClaudeCodeSessionIdentitySignal {
  return withoutUndefinedValues({
    ...withoutUndefinedValues(incoming),
    ...withoutUndefinedValues(existing),
    observedAt:
      incoming.observedAt < existing.observedAt
        ? incoming.observedAt
        : existing.observedAt,
  });
}

export function isSessionIdentitySignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeSessionIdentitySignal {
  return signal.type === ClaudeCodeOtelSignalType.SessionIdentity;
}
