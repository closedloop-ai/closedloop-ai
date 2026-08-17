/**
 * Audit Bot (PRD-556 M1 / FEA-3847) IPC contract — the wire shapes shared by the
 * main-process handler, the preload bridge, and the renderer. Kept free of
 * `node:*` and `@repo/crewd/harness` (Node-only) imports so it is safe to pull
 * into the renderer graph. The crewd types it re-uses (`Finding`,
 * `CascadeAttempt`, `HarnessName`) are imported from crewd's Node-free leaf
 * subpaths (`@repo/crewd/model`, `@repo/crewd/passes/findings`) rather than the
 * root barrel: the barrel type-re-exports the Node-only `harness/cascade`
 * module, which the renderer tsconfig (no `@types/node`) would then try to
 * type-check. The leaf modules only reach `zod` and a pure type, so they stay
 * renderer-safe under `tsc`.
 */
import type { CascadeAttempt, CascadeStep } from "@repo/crewd/model";
import { AuditScope, HarnessName } from "@repo/crewd/model";
import type { FiledFindingStatus, Finding } from "@repo/crewd/passes/findings";
import {
  AUDIT_CHARACTER_ROSTER,
  type AuditCharacterRosterEntry,
} from "./audit-character-roster.generated.js";

/**
 * A review-character id — the prompt file's path relative to
 * `resources/audit-characters/` (no `.md`), e.g. `docs-darwin` or
 * `kaitic/desktop-denny`. The full valid set is the discovered
 * {@link AUDIT_CHARACTER_ROSTER} (FEA-4013); the runner resolves it as
 * `join(promptsDir, `${id}.md`)`. Kept a plain string on the wire so a
 * version-skewed client can still name a character this build hasn't shipped —
 * the main-process validator rejects any id not in the roster before spawning.
 */
export type AuditCharacterId = string;

/**
 * The well-known core review characters (the M1/M4 top-level cast). Retained as
 * named constants for defaults, tests, and the {@link AUDIT_DOCS_DARWIN_TAG}
 * back-reference; the FULL runnable cast is {@link AUDIT_CHARACTER_ROSTER},
 * discovered from the shipped prompt files (FEA-4013). Each id maps 1:1 to a
 * bundled `<id>.md` prompt in `resources/audit-characters/` (shipped unpacked
 * via extraResources).
 */
export const AuditCharacter = {
  /** Documentation-vs-code audit (stale/wrong/contradicted docs). */
  DocsDarwin: "docs-darwin",
  /** Correctness & bug audit (logic errors, null hazards, silent passthrough). */
  CodeCassandra: "code-cassandra",
  /** Vulnerability audit (injection, authz gaps, secret handling). */
  SecuritySentinel: "security-sentinel",
  /** Performance audit (N+1, O(n²) hot paths, unbounded memory). */
  PerfPathfinder: "perf-pathfinder",
} as const;
export type AuditCharacter =
  (typeof AuditCharacter)[keyof typeof AuditCharacter];

/** Presentation + tag metadata for one review character (drives the UI picker). */
export type AuditCharacterMeta = {
  /** Short display name shown in the character picker. */
  label: string;
  /** One-line description of what the character reviews. */
  description: string;
  /** The ClosedLoop tag stamped on every issue this character files. */
  tag: string;
};

/**
 * Per-character presentation + tag metadata. Keyed exhaustively by
 * {@link AuditCharacter}, so adding a character to the const above fails
 * typecheck until it is described here (and given a filing tag). One canonical
 * home for the label/description/tag so the renderer picker, the tag mapping,
 * and the run wiring never drift.
 */
export const AUDIT_CHARACTER_META: Record<AuditCharacter, AuditCharacterMeta> =
  {
    [AuditCharacter.DocsDarwin]: {
      label: "Docs Darwin",
      description:
        "Audits documentation against the code at HEAD and reports where the docs are stale, wrong, or contradicted.",
      tag: "agent-docs-darwin",
    },
    [AuditCharacter.CodeCassandra]: {
      label: "Code Cassandra",
      description:
        "Audits the source for correctness bugs — logic errors, null hazards, silent passthrough, and error-handling gaps.",
      tag: "agent-code-cassandra",
    },
    [AuditCharacter.SecuritySentinel]: {
      label: "Security Sentinel",
      description:
        "Audits the source for vulnerabilities — injection, broken authz/trust boundaries, and unsafe secret handling.",
      tag: "agent-security-sentinel",
    },
    [AuditCharacter.PerfPathfinder]: {
      label: "Perf Pathfinder",
      description:
        "Audits the source for performance problems — N+1 I/O, O(n²) hot paths, redundant work, and unbounded memory.",
      tag: "agent-perf-pathfinder",
    },
  };

/**
 * Every runnable review-character id, discovered from the shipped prompt files
 * (FEA-4013). This is the authoritative validation set: the main-process IPC
 * handler rejects any `character` not in here before spawning, and every id
 * resolves to a `<id>.md` prompt the crewd runner can launch.
 */
export const AUDIT_CHARACTER_IDS: ReadonlySet<AuditCharacterId> = new Set(
  AUDIT_CHARACTER_ROSTER.map((entry) => entry.id)
);

/** Roster entries indexed by id, for O(1) presentation/tag lookup. */
const ROSTER_BY_ID: ReadonlyMap<AuditCharacterId, AuditCharacterRosterEntry> =
  new Map(AUDIT_CHARACTER_ROSTER.map((entry) => [entry.id, entry]));

/**
 * Presentation + tag metadata for any character in the full cast. Prefers the
 * curated core-4 {@link AUDIT_CHARACTER_META} (richer descriptions) and falls
 * back to the file-discovered roster entry for the rest. Returns `null` for an
 * unknown id so callers surface a clean state rather than fabricating a label.
 */
export function characterMetaFor(
  id: AuditCharacterId
): AuditCharacterMeta | null {
  // `Object.hasOwn`, not `in`: an untrusted id like `"toString"`/`"constructor"`
  // is present on `Object.prototype` and would make `in` index into an inherited
  // member. Own-key check keeps the core-4 lookup pollution-safe.
  if (Object.hasOwn(AUDIT_CHARACTER_META, id)) {
    return AUDIT_CHARACTER_META[id as AuditCharacter];
  }
  const entry = ROSTER_BY_ID.get(id);
  if (!entry) {
    return null;
  }
  return { label: entry.label, description: entry.description, tag: entry.tag };
}

/**
 * The scope preset the audit runs against (FEA-3850 M4). The canonical wire enum
 * ({@link AuditScope}) lives in `@repo/crewd/model`; import it from there
 * directly (this contract only owns the presentation metadata below). `docs`
 * narrows to documentation files, `changed-since-main` diffs vs. the merge-base
 * with the repo's main branch, and `whole-repo` reviews everything (the M1
 * default).
 */

/** Presentation metadata for one scope preset (drives the scope selector). */
export type AuditScopeMeta = { label: string; description: string };

/**
 * Per-scope presentation metadata, keyed exhaustively by {@link AuditScope} so a
 * new preset fails typecheck until it is described here.
 */
export const AUDIT_SCOPE_META: Record<AuditScope, AuditScopeMeta> = {
  [AuditScope.Docs]: {
    label: "Docs",
    description:
      "Review documentation surfaces (READMEs, AGENTS/CLAUDE, docs/).",
  },
  [AuditScope.ChangedSinceMain]: {
    label: "Changed since main",
    description: "Review only files changed vs. the merge-base with main.",
  },
  [AuditScope.WholeRepo]: {
    label: "Whole repo",
    description: "Review the entire repository.",
  },
};

/** The default scope when the caller does not choose one (M1 behavior). */
export const DEFAULT_AUDIT_SCOPE: AuditScope = AuditScope.WholeRepo;

/**
 * The default harness cascade a run drives when the operator does not customize
 * one (FEA-4009) — the historical fixed "Switzerland" order (codex → opencode →
 * claude), now expressed as `(harness, model?)` steps so it is the SSOT shared
 * by the renderer picker's initial state and the main-process fallback. Each
 * step leaves `model` unset ⇒ that harness's default model (see crewd
 * `DEFAULT_MODEL`), matching the pre-FEA-4009 behavior exactly.
 */
export const DEFAULT_AUDIT_CASCADE: readonly CascadeStep[] = [
  { harness: HarnessName.Codex },
  { harness: HarnessName.Opencode },
  { harness: HarnessName.Claude },
];

/** request/response IPC channels (invoke) + the push channel (event). */
export const AuditIpcChannel = {
  /** `audit:run` — execute a review pass against the open repo; returns findings. */
  Run: "desktop:audit:run",
  /** Push channel: streamed cascade progress for an in-flight run. */
  Progress: "desktop:audit:progress",
  /**
   * `audit:file` (PRD-556 M3 / FEA-3849) — file the user's SELECTED findings to
   * ClosedLoop as dedup-guarded TRIAGE issues. Never invoked automatically: the
   * renderer sends it only after the user selects findings and confirms.
   */
  File: "desktop:audit:file",
} as const;
export type AuditIpcChannel =
  (typeof AuditIpcChannel)[keyof typeof AuditIpcChannel];

/**
 * The `audit:file` request (PRD-556 M3). Carries the exact findings the user
 * selected — never the full result set implicitly — plus the target ClosedLoop
 * `projectSlug` and optional `assigneeId`. The main process builds the typed
 * ClosedLoop client (bearer = the desktop access token, base = the api origin)
 * and drives crewd's dedup-guarded `fileFindings` path from the trust zone.
 */
export type AuditFileRequest = {
  character: AuditCharacterId;
  /** The findings the user explicitly selected to file. */
  findings: Finding[];
  /** Target ClosedLoop project slug/id the issues are filed into. */
  projectSlug: string;
  /** Optional ClosedLoop assignee for the created TRIAGE issues. */
  assigneeId?: string | null;
};

/** Why an `audit:file` could not run (before any network call to ClosedLoop). */
export const AuditFileFailureReason = {
  /** The `auditBot` Labs flag is off. */
  Disabled: "disabled",
  /** The request was malformed (no findings, missing project, bad character). */
  InvalidRequest: "invalid_request",
  /** The desktop session has no access token — the user must sign in. */
  NotAuthenticated: "not_authenticated",
  /** The ClosedLoop network call failed (surfaced verbatim in `error`). */
  FilingFailed: "filing_failed",
} as const;
export type AuditFileFailureReason =
  (typeof AuditFileFailureReason)[keyof typeof AuditFileFailureReason];

/** Per-finding outcome mirrored to the renderer (key + title + created/skipped). */
export type AuditFiledFinding = {
  /** The finding's dedup key — stable across runs. */
  key: string;
  title: string;
  status: FiledFindingStatus;
  /** The created issue's id, when `status === "created"`. */
  documentId?: string;
};

/**
 * The `audit:file` result. On success `ok` is true and `filed` carries one
 * outcome per selected finding (created vs. deduped/skipped). On a pre-flight or
 * network failure `ok` is false, `reason` is set, and `filed` is empty.
 */
export type AuditFileResult = {
  ok: boolean;
  /** One outcome per selected finding, in request order. */
  filed: AuditFiledFinding[];
  /** Count of newly-created TRIAGE issues. */
  created: number;
  /** Count of findings skipped because an open issue already exists (dedup). */
  skipped: number;
  /**
   * Count of findings whose issue creation failed (partial-batch failure).
   * These are NOT filed and are kept in triage for retry. Optional so older
   * renderers/payloads that predate partial outcomes degrade to `0`.
   */
  failed?: number;
  reason: AuditFileFailureReason | null;
  error: string | null;
};

/**
 * The ClosedLoop tag stamped on every issue Docs Darwin files (PRD-556 M3).
 * Retained as the canonical Docs Darwin tag; other characters resolve their tag
 * from {@link AUDIT_CHARACTER_META}. Kept equal to the meta entry.
 */
export const AUDIT_DOCS_DARWIN_TAG =
  AUDIT_CHARACTER_META[AuditCharacter.DocsDarwin].tag;

/**
 * The renderer's `audit:run` request. `repoDir` is the currently-open repo to
 * audit; the main process validates it against the sandbox allow-list before
 * spawning any harness. `scope` is an optional free-text focus hint.
 */
export type AuditRunRequest = {
  character: AuditCharacterId;
  repoDir: string;
  /**
   * The scope preset the run reviews (FEA-3850 M4). Absent ⇒
   * {@link DEFAULT_AUDIT_SCOPE} (`whole-repo`), preserving the M1 behavior for
   * an older renderer that does not send it.
   */
  scopePreset?: AuditScope;
  /** Optional free-text focus hint layered on top of the scope preset. */
  scope?: string | null;
  /**
   * The ordered harness cascade the run drives (FEA-4009): one or more
   * `(harness, model?)` steps tried first-to-last, stopping on first success —
   * exactly what the operator picks in the run controls. Absent or empty ⇒
   * {@link DEFAULT_AUDIT_CASCADE}, preserving the fixed-cascade behavior for an
   * older renderer that does not send it. Additive and version-skew safe: the
   * main process falls back to the default when the field is omitted, and the
   * cascade skips any step whose harness is not installed.
   */
  cascade?: CascadeStep[];
};

/** Why an `audit:run` could not even start (before any cascade attempt). */
export const AuditRunFailureReason = {
  /** The `auditBot` Labs flag is off. */
  Disabled: "disabled",
  /** `repoDir` is outside the sandbox allow-list (or missing/invalid). */
  RepoNotAllowed: "repo_not_allowed",
  /** No character prompt / other setup fault surfaced by the pass. */
  SetupFailed: "setup_failed",
} as const;
export type AuditRunFailureReason =
  (typeof AuditRunFailureReason)[keyof typeof AuditRunFailureReason];

/**
 * The `audit:run` result. `ok` reflects whether a harness produced a clean run;
 * `findings` is present even on a non-`ok` run that wrote partial findings. On a
 * pre-flight failure (flag off / repo denied) `reason` is set and findings empty.
 */
export type AuditRunResult = {
  ok: boolean;
  character: string;
  harnessUsed: HarnessName | null;
  attempts: CascadeAttempt[];
  findings: Finding[];
  reason: AuditRunFailureReason | null;
  error: string | null;
};

/**
 * A streamed progress event, tagged with the `runId` so the renderer can route
 * concurrent runs. Mirrors the crewd `AuditProgressEvent` phases.
 */
export type AuditProgressPayload = { runId: string } & (
  | {
      phase: "start";
      character: string;
      repoDir: string;
      cascade: HarnessName[];
    }
  | { phase: "output"; chunk: string }
  | { phase: "attempt"; attempt: CascadeAttempt }
  | {
      phase: "done";
      ok: boolean;
      harnessUsed: HarnessName | null;
      findingsCount: number;
    }
);
