/**
 * FEA-2870 / FEA-3616: single source of truth for classifying a session as
 * headless (fully autonomous, launched non-interactively) vs. human-interactive,
 * from the harness calling params captured at parse time.
 *
 * A headless session's initial prompt still emits user-type events, and an
 * automated driver (a scheduled `/loop`, an SDK/exec worker, an agent-to-agent
 * reviewer) keeps injecting more `user`-role prompts as the run proceeds. Those
 * agent-authored prompts are NOT human steering, so turn-count heuristics that
 * key off the `user` role misclassify the whole run as human-steered and inflate
 * `humanTurns`. The calling params are the reliable signal, so the write-time
 * `is_human` classification, the per-turn heatmap buckets, and the read-time
 * autonomy score all gate on this one helper.
 *
 * Entrypoint families observed across the corpus (Claude + Codex), verified
 * against the signed per-dossier golden oracles:
 * - interactive (a human at a keyboard): `cli`, `codex-tui`, `codex_cli_rs`,
 *   `codex_vscode`, and — CRITICALLY — `codex_sdk_ts` (the Codex VS Code /
 *   Conductor IDE transport: it carries `sdk` in its name but is a person typing
 *   in the IDE; golden dossiers `f04610b7` / `8bbdbfab` sign its prompts as
 *   GENUINE human turns).
 * - autonomous (non-interactive, scripted/injected prompts): Claude's SDK
 *   launchers `sdk-ts` / `sdk-cli` (prefix `sdk-`), and Codex's exec family
 *   `codex_exec` / `claude-codex-exec` / `codex-exec` (token `exec`).
 *
 * FEA-3616 fix: the write-side rollup previously matched `entrypoint` with an
 * EXACT allow-list (`IN ('sdk-ts')`), so `sdk-cli` and the whole `exec` family
 * (`codex_exec`, `claude-codex-exec`, …) slipped through as human-interactive and
 * their scripted / agent-to-agent prompts inflated `humanTurns` (and the run
 * scored as human). It now shares THIS predicate — the same
 * `sdk-`-prefix-OR-`exec`-token rule the per-turn read path already used — so the
 * rollup, the buckets, and this helper agree and the full autonomous family is
 * covered WITHOUT sweeping in the interactive `codex_sdk_ts` IDE transport.
 * `permissionMode === "bypassPermissions"` stays an exact-match automation
 * signal.
 *
 * `HEADLESS_ENTRYPOINT_PREFIXES` / `HEADLESS_ENTRYPOINT_TOKENS` are the SSOT the
 * write-side SQL predicate (`headlessMetadataSql`) is built from, so the SQL, the
 * buckets, and this JS helper can never drift.
 *
 * ISS-7260 — `promptSource` was evaluated as a replacement input and NOT adopted.
 * Claude stamps a per-turn `promptSource` (`typed` / `sdk` / `system` / `queued`),
 * which is stronger evidence than an entrypoint string and at the granularity both
 * consumers reason at. Measured over the operator's 7,647 Claude transcripts on
 * 2026-08-22 (873 of them carry the field at all; Codex and OpenCode stamp no
 * equivalent, so the ~1,410 OpenCode sessions in the same corpus are outside it):
 * `typed` turns occurred under `cli` ONLY, and `sdk` turns under `sdk-cli` and
 * `claude-desktop` only. Against the entrypoint answer that is 728 headless
 * sessions with zero typed turns and 139 interactive sessions with at least one —
 * agreeing — and ZERO headless sessions carrying a typed turn, the disagreement
 * that would have meant the rules demote real human steering.
 *
 * The one contradiction is small and pointed: 3 `claude-desktop` sessions whose
 * only stated prompt source was `sdk`, i.e. the census below calls them
 * interactive while Claude's own per-turn record says the prompt was injected.
 * n=3 does not buy a reclassification — under the ticket's own constraint that is
 * a `DATA_REVISION` bump and a full corpus rebuild — so behavior is unchanged and
 * the finding is recorded here for whoever revisits it with more data. Note also
 * that the field is session-level in our own pipeline today: ISS-7259 captures
 * only the FIRST user turn's value into `metadata.launchAttribution.promptSource`,
 * so adopting it per-turn needs a producer change first.
 */
export const HEADLESS_ENTRYPOINT_PREFIXES = ["sdk-"] as const;
export const HEADLESS_ENTRYPOINT_TOKENS = ["exec"] as const;
export const HEADLESS_PERMISSION_MODES = ["bypassPermissions"] as const;

export type HeadlessSignal = {
  entrypoint?: string | null;
  permissionMode?: string | null;
};

/**
 * True when the `entrypoint` string marks an SDK/exec-launched (non-interactive)
 * run: it starts with a headless SDK prefix (`sdk-…`) OR contains an autonomous
 * token (`exec`). Case-insensitive. Mirrors the SQL predicate in
 * `headlessMetadataSql`. Deliberately excludes the interactive `codex_sdk_ts` IDE
 * transport (contains `sdk` but is NOT `sdk-`-prefixed).
 */
export function isHeadlessEntrypoint(
  entrypoint: string | null | undefined
): boolean {
  return classifyEntrypoint(entrypoint) === EntrypointClass.Headless;
}

/**
 * ISS-7260: what the classifier actually knows about one `entrypoint` value.
 *
 * {@link isHeadlessEntrypoint} answers a boolean, and a boolean cannot tell a
 * DECIDED interactive value (`cli`, `codex-tui` — evidenced against the golden
 * dossiers) apart from one nothing has ever ruled on, which lands in the same
 * class only because no substring matched. Those are different facts and the
 * second is the one an operator needs to see: the rules are string heuristics
 * over an open set that upstream Claude/Codex/OpenCode extend without notice, so
 * a one-character rename ("sdk-cli" → "sdkcli") silently moves a whole
 * population from autonomous to human-steered and every downstream count with
 * it.
 *
 * {@link Absent} is kept apart from {@link UnrecognizedInteractive} for the same
 * reason: a session that stated no entrypoint at all is a parser/harness gap, not
 * a value nobody has classified, and folding the two would report a missing
 * field as harness drift on every legacy row.
 */
export const EntrypointClass = {
  /** Matched a headless prefix/token rule. */
  Headless: "headless",
  /** A value {@link KNOWN_INTERACTIVE_ENTRYPOINTS} has decided is interactive. */
  KnownInteractive: "known-interactive",
  /** Stated, matched no rule, and never censused — interactive BY DEFAULT. */
  UnrecognizedInteractive: "unrecognized-interactive",
  /** The harness stated no entrypoint (null/undefined/empty). */
  Absent: "absent",
} as const;

export type EntrypointClass =
  (typeof EntrypointClass)[keyof typeof EntrypointClass];

/**
 * THIS SET IS A DRIFT DETECTOR, NOT AN ALLOW-LIST.
 *
 * Membership changes NOTHING about how a session is classified — every value here
 * is interactive by falling through the headless rules, exactly as it was before
 * the set existed, and a value's absence never makes it headless. What it changes
 * is whether the fall-through was DECIDED or accidental: a value listed here is
 * one this repo has looked at and ruled interactive, so
 * {@link classifyEntrypoint} can report everything else as
 * {@link EntrypointClass.UnrecognizedInteractive} and the harness's next new
 * spelling arrives as a log line instead of a silent reclassification.
 *
 * So: adding a value here asserts that its interactive reading was CHECKED, not
 * merely that it has been seen in a corpus. Compared lowercased, because the
 * headless rules are case-insensitive and `Codex Desktop` is stamped with
 * capitals.
 *
 * Sources, all of them decided:
 * - the value each parser stamps when the harness states none, which is every
 *   member of `Harness` — `claude`, `codex`, `cursor`, `copilot`, `opencode`.
 *   Those are OUR OWN defaults, so omitting one makes the drift report's first
 *   line on a normal install a false positive about upstream, which is how an
 *   operator learns to ignore the real one. `headless.test.ts` asserts every
 *   `Harness` member is present rather than importing the const here, so a sixth
 *   harness fails a test instead of shipping as a log line, and this
 *   bundle-sensitive module keeps its zero imports;
 * - the Claude and Codex interactive families the FEA-3616 header evidences
 *   against the signed golden dossiers, INCLUDING `codex_sdk_ts`, the IDE
 *   transport that carries `sdk` and is a person typing;
 * - the bare `vscode` the Claude lane preserves. Claude's parser is a straight
 *   passthrough of whatever the transcript states
 *   (`parse-claude.ts` `accumulator.entrypoint ??= stringValue(record.entrypoint)`),
 *   pinned by `parse-claude-session-shape.test.ts`'s "keeps an explicit
 *   entrypoint" case, so the value reaches this classifier verbatim rather than
 *   normalized into the Codex-shaped `codex_vscode` below. Ruled interactive on
 *   the same reading the header applies to `codex_vscode` — an editor is a
 *   person at a keyboard — and censused so a VS Code session does not report as
 *   upstream drift on every install that has one;
 * - `claude-desktop` and `codex desktop`, observed in the live corpus and ruled
 *   interactive here on the same reading the header applies to `codex_vscode` —
 *   a desktop app is a person at a keyboard. Note this is the weaker half of the
 *   set: see the ISS-7260 measurement of `promptSource` for why `claude-desktop`
 *   is the one value where Claude's own per-turn evidence argues the other way.
 */
export const KNOWN_INTERACTIVE_ENTRYPOINTS: ReadonlySet<string> = new Set([
  "claude",
  "claude-desktop",
  "cli",
  "codex",
  "codex desktop",
  "codex-tui",
  "codex_cli_rs",
  "codex_sdk_ts",
  "codex_vscode",
  "copilot",
  "cursor",
  "opencode",
  "vscode",
]);

/**
 * Classify one raw `entrypoint` value. The {@link EntrypointClass.Headless}
 * answer is the SAME rule {@link isHeadlessEntrypoint} has always applied — this
 * only splits the false half into the three facts a boolean collapsed.
 */
export function classifyEntrypoint(
  entrypoint: string | null | undefined
): EntrypointClass {
  if (entrypoint === null || entrypoint === undefined || entrypoint === "") {
    return EntrypointClass.Absent;
  }
  const normalized = entrypoint.toLowerCase();
  const headless =
    HEADLESS_ENTRYPOINT_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix)
    ) || HEADLESS_ENTRYPOINT_TOKENS.some((token) => normalized.includes(token));
  if (headless) {
    return EntrypointClass.Headless;
  }
  return KNOWN_INTERACTIVE_ENTRYPOINTS.has(normalized)
    ? EntrypointClass.KnownInteractive
    : EntrypointClass.UnrecognizedInteractive;
}

/** True when the calling params mark the session as headless/autonomous. */
export function isHeadlessSession(signal: HeadlessSignal): boolean {
  const permissionMode = signal.permissionMode ?? null;
  return (
    isHeadlessEntrypoint(signal.entrypoint ?? null) ||
    (permissionMode !== null &&
      (HEADLESS_PERMISSION_MODES as readonly string[]).includes(permissionMode))
  );
}
