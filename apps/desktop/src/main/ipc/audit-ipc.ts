/**
 * @file audit-ipc.ts
 * @description FEA-3847 (PRD-556 M1) — the `audit:run` IPC.
 *
 * Runs a crewd review character (Docs Darwin) against the currently-open repo
 * and returns the parsed findings, streaming cascade progress to the renderer on
 * a push channel. SECURITY-CRITICAL boundary: the handler is fail-closed —
 * `assertTrustedIpcSender` rejects any sender that is not the trusted renderer
 * window BEFORE anything runs, and the `auditBot` Labs flag gates the capability
 * (off ⇒ the run is refused without spawning). Local CLI execution stays in the
 * main/gateway trust zone via {@link AuditService}; the repo path is
 * sandbox-validated there before any harness spawns.
 */

import { randomUUID } from "node:crypto";
import {
  AuditScope,
  type CascadeStep,
  cascadeStepSchema,
  HarnessName,
} from "@repo/crewd/model";
import type { AuditProgressEvent } from "@repo/crewd/passes/audit";
import type { Finding } from "@repo/crewd/passes/findings";
import {
  AUDIT_CHARACTER_IDS,
  type AuditCharacterId,
  AuditFileFailureReason,
  type AuditFileRequest,
  type AuditFileResult,
  AuditIpcChannel,
  type AuditProgressPayload,
  AuditRunFailureReason,
  type AuditRunRequest,
  type AuditRunResult,
} from "../../shared/audit-contract.js";
import type { AuditService } from "../audit/audit-service.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

type IpcMainLike = {
  handle: (
    channel: AuditIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

export type AuditIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  /** The `auditBot` Labs flag — off ⇒ the capability is refused. */
  isAuditBotEnabled: () => boolean;
  /** The main-process audit runner (owns sandbox validation + cascade). */
  auditService: AuditService;
  /** Push a progress event to the renderer window (fail-closed on teardown). */
  sendProgress: (payload: AuditProgressPayload) => void;
};

/**
 * Validate an untrusted character value against the full discovered cast
 * ({@link AUDIT_CHARACTER_IDS}, FEA-4013). An id outside the roster is rejected
 * before any spawn — a version-skewed or malformed client cannot name a
 * character this build did not ship a prompt for.
 */
function toAuditCharacter(value: unknown): AuditCharacterId | null {
  return typeof value === "string" && AUDIT_CHARACTER_IDS.has(value)
    ? value
    : null;
}

/** The valid scope-preset ids. */
const VALID_SCOPES = new Set<string>(Object.values(AuditScope));

/** A present scope-preset value that is not a known preset id. */
const INVALID_SCOPE = Symbol("invalid-scope");

/**
 * Validate an untrusted scope-preset value. An ABSENT field (undefined/null)
 * legitimately means "no preset ⇒ whole-repo default"; a PRESENT but unknown
 * value is rejected (returns {@link INVALID_SCOPE}) rather than silently
 * defaulting to the broadest whole-repo audit — a version-skewed or malformed
 * client must not widen the scope by sending a garbage preset.
 */
function toAuditScope(
  value: unknown
): AuditScope | undefined | typeof INVALID_SCOPE {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" && VALID_SCOPES.has(value)
    ? (value as AuditScope)
    : INVALID_SCOPE;
}

/** A present cascade whose entries are not all valid `(harness, model?)` steps. */
const INVALID_CASCADE = Symbol("invalid-cascade");

/**
 * The most steps a cascade may carry: one per known harness. A well-formed
 * cascade drives each harness at most once (the fallback order is a permutation
 * of the roster, not a repeat list), so this is the natural ceiling — it also
 * bounds the untrusted array so a malformed client cannot ship thousands of
 * repeated steps for `runCascade` to spawn+retry.
 */
const MAX_CASCADE_STEPS = Object.keys(HarnessName).length;

/**
 * Validate an untrusted cascade field (FEA-4009). An ABSENT field (undefined or
 * null) legitimately means "no custom cascade ⇒ the main-process default"; so
 * does an EMPTY array — the cascade picker documents "leave all off to use the
 * default order" and clearing every harness sends `cascade: []`, which
 * `AuditService.resolveCascade()` maps to {@link DEFAULT_AUDIT_CASCADE}. Both
 * collapse to `undefined` here. A PRESENT, non-empty value must be an array
 * whose every entry parses as a `(harness, model?)` step via the canonical
 * `cascadeStepSchema` (which also normalizes the backward-compatible bare-name /
 * `"harness:model"` shorthands).
 *
 * At this IPC boundary the array is also capped at {@link MAX_CASCADE_STEPS}
 * (one step per known harness) and a repeated harness is rejected — a cascade is
 * an ordered fallback across DISTINCT harnesses, so a duplicate harness (even
 * with a different model) is malformed. Both guards return {@link
 * INVALID_CASCADE} so a version-skewed or malicious client cannot make
 * `runCascade` spawn+retry thousands of repeated steps. Anything else — a
 * non-array, an over-length list, an unknown harness, or a duplicate — is
 * rejected rather than silently dropped, so a malformed client fails loudly
 * instead of running the default while believing its choice was honored.
 */
function toCascade(
  value: unknown
): CascadeStep[] | undefined | typeof INVALID_CASCADE {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return INVALID_CASCADE;
  }
  if (value.length === 0) {
    return undefined;
  }
  if (value.length > MAX_CASCADE_STEPS) {
    return INVALID_CASCADE;
  }
  const steps: CascadeStep[] = [];
  const seenHarnesses = new Set<HarnessName>();
  for (const entry of value) {
    const parsed = cascadeStepSchema.safeParse(entry);
    if (!parsed.success) {
      return INVALID_CASCADE;
    }
    if (seenHarnesses.has(parsed.data.harness)) {
      return INVALID_CASCADE;
    }
    seenHarnesses.add(parsed.data.harness);
    steps.push(parsed.data);
  }
  return steps;
}

function parseRunRequest(arg: unknown): AuditRunRequest | null {
  if (!arg || typeof arg !== "object") {
    return null;
  }
  const raw = arg as Record<string, unknown>;
  const character = toAuditCharacter(raw.character);
  if (!character) {
    return null;
  }
  if (typeof raw.repoDir !== "string" || raw.repoDir.length === 0) {
    return null;
  }
  const scopePreset = toAuditScope(raw.scopePreset);
  if (scopePreset === INVALID_SCOPE) {
    return null;
  }
  const cascade = toCascade(raw.cascade);
  if (cascade === INVALID_CASCADE) {
    return null;
  }
  const scope =
    typeof raw.scope === "string" && raw.scope.length > 0 ? raw.scope : null;
  return { character, repoDir: raw.repoDir, scopePreset, scope, cascade };
}

function invalidRequestResult(): AuditRunResult {
  return {
    ok: false,
    character: "",
    harnessUsed: null,
    attempts: [],
    findings: [],
    reason: AuditRunFailureReason.SetupFailed,
    error: "invalid audit:run request",
  };
}

function disabledResult(character: string): AuditRunResult {
  return {
    ok: false,
    character,
    harnessUsed: null,
    attempts: [],
    findings: [],
    reason: AuditRunFailureReason.Disabled,
    error: "Audit Bot is disabled.",
  };
}

/** Coerce one untrusted finding entry into a crewd {@link Finding}, or null. */
function toFinding(value: unknown): Finding | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
    return null;
  }
  return {
    title: raw.title,
    description: typeof raw.description === "string" ? raw.description : "",
    signature: typeof raw.signature === "string" ? raw.signature : undefined,
  };
}

/** Validate the untrusted `audit:file` request; null ⇒ malformed. */
function parseFileRequest(arg: unknown): AuditFileRequest | null {
  if (!arg || typeof arg !== "object") {
    return null;
  }
  const raw = arg as Record<string, unknown>;
  const character = toAuditCharacter(raw.character);
  if (!character) {
    return null;
  }
  if (typeof raw.projectSlug !== "string" || raw.projectSlug.length === 0) {
    return null;
  }
  if (!Array.isArray(raw.findings) || raw.findings.length === 0) {
    return null;
  }
  const findings: Finding[] = [];
  for (const entry of raw.findings) {
    const finding = toFinding(entry);
    if (!finding) {
      return null;
    }
    findings.push(finding);
  }
  const assigneeId =
    typeof raw.assigneeId === "string" && raw.assigneeId.length > 0
      ? raw.assigneeId
      : null;
  return { character, findings, projectSlug: raw.projectSlug, assigneeId };
}

function fileRefusal(reason: AuditFileFailureReason): AuditFileResult {
  return { ok: false, filed: [], created: 0, skipped: 0, reason, error: null };
}

export function registerAuditIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: AuditIpcDeps
): void {
  ipcMainLike.handle(AuditIpcChannel.Run, async (event, request) => {
    // Sender trust is the load-bearing boundary: an untrusted/secondary renderer
    // must never drive a local harness spawn. Assert before the flag check so an
    // untrusted sender is rejected outright, not swallowed into a result object.
    assertTrustedIpcSender(deps.isTrustedSender, event);

    const parsed = parseRunRequest(request);
    if (!parsed) {
      return invalidRequestResult();
    }
    // Gate AFTER parse so a disabled flag returns a clean, typed refusal that
    // still names the requested character; nothing spawns while off.
    if (!deps.isAuditBotEnabled()) {
      return disabledResult(parsed.character);
    }

    const runId = randomUUID();
    const onProgress = (progressEvent: AuditProgressEvent) =>
      deps.sendProgress({ runId, ...progressEvent });

    return await deps.auditService.run({
      character: parsed.character,
      repoDir: parsed.repoDir,
      scopePreset: parsed.scopePreset,
      scope: parsed.scope,
      cascade: parsed.cascade,
      onProgress,
    });
  });

  // PRD-556 M3 / FEA-3849: file the user's SELECTED findings to ClosedLoop.
  // NEVER auto-files — this handler only runs when the renderer sends the
  // request after the user selects findings and confirms. Same fail-closed
  // boundary as `run`: sender trust first, then the `auditBot` flag gate; the
  // typed ClosedLoop client + network call live in AuditService (main-side).
  ipcMainLike.handle(AuditIpcChannel.File, async (event, request) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);

    const parsed = parseFileRequest(request);
    if (!parsed) {
      return fileRefusal(AuditFileFailureReason.InvalidRequest);
    }
    if (!deps.isAuditBotEnabled()) {
      return fileRefusal(AuditFileFailureReason.Disabled);
    }

    return await deps.auditService.file({
      character: parsed.character,
      findings: parsed.findings,
      projectSlug: parsed.projectSlug,
      assigneeId: parsed.assigneeId,
    });
  });
}
