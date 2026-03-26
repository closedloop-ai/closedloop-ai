# Implementation Plan: Migrate Work Directory from `.claude/work` to `.closedloop-ai/work`

## Summary

Claude now treats `.claude/` as a protected directory and refuses to write there. This plan stops ALL writes to `.claude/` by the ClosedLoop system. The work directory used by the loops system (where run-loop.sh writes its state, PID files, logs, plan artifacts, and chat histories) currently defaults to `{worktreeDir}/.claude/work`. This plan migrates all hardcoded `.claude/work` paths to `.closedloop-ai/work` in both `~/Source/symphony-alpha` and `~/Source/closedloop-electron`, updates the `run-loop.sh` and `cancel-code.md` scripts in `~/Source/claude-plugins`, force-kills any legacy processes still writing to `.claude/work`, migrates existing stopped-worktree state on first access using a safe guarded pattern, fixes a shallow-copy bug in the worktree save/restore logic, and migrates the global chat history paths (`~/.claude/.closedloop/chats/`) to `~/.closedloop-ai/chats/` in all three global-chat route files.

## Architecture Decisions

| Decision | Options | Chosen | Rationale |
|----------|---------|--------|-----------|
| Governing principle | Migrate only work-dir paths vs. stop all `.claude` writes | Stop ALL `.claude` writes (excluding Claude CLI system dirs and legacy read-only fallbacks) | Claude now protects `.claude/`; any write there will fail. Legacy read-only fallbacks for `.claude/.symphony/...` and `.claude/.learnings/...` are kept as migration sources only -- they are never the write destination |
| Where to centralize the constant | New shared module vs inline at each callsite | Add `WORK_SUBDIR` constant in `process-utils.ts` (symphony-alpha) and `symphony-utils.ts` (closedloop-electron) | Both files are already the single source of truth for work-dir utilities; avoids a new file for a one-liner constant |
| Handling legacy running/stopped jobs | Symlink/redirect `.claude/work` to new path vs force-kill and require re-launch | Force-kill legacy jobs at launch; guarded migration for stopped-worktree state on first access | Running processes cannot transparently redirect their writes; symlinks would silently hide failures. Hard-kill is safe because users must re-launch anyway after the deployment |
| Migration pattern for read-only handlers | `migrateWorkDirIfNeeded` (rename) vs `findFirstExisting` (read-only fallback) | `findFirstExisting` for pure read handlers that accept raw caller-supplied paths; guarded `migrateWorkDirIfNeeded` for handlers whose path comes from `getWorktreeParentDir()` and where no live legacy PID exists | Calling `migrateWorkDirIfNeeded` on a raw, unvalidated query param turns a read endpoint into an arbitrary filesystem rename. `findFirstExisting` (the pattern already used in closedloop-electron's `symphony-status.ts`) is purely additive and cannot corrupt live state |
| Write-handler live-process guard | Call `migrateWorkDirIfNeeded` unconditionally vs preflight PID check | Preflight: if new dir exists use it; else if legacy PID exists and process is alive return 409; else migrate and use new path | `migrateWorkDirIfNeeded`'s own docstring says "caller must verify no live process is writing to the old path." Without the check, the first write action (e.g., upload) would rename a live legacy `.claude/work` tree mid-run, corrupting an in-flight job |
| Kill route legacy support | Update kill to new path only vs. dual-path lookup for both PID file and loop state file | Dual-path lookup in `resolvePid` (check new path, then old path) and `cancelLoop` (try new path, then old path) | After launch-path migration, legacy jobs whose PID file is at `.claude/work/process.pid` must still be stoppable without requiring a re-launch. Removing the legacy fallback would permanently orphan those processes |
| Shared helpers `readProcessPid` / `readLiveActivity` | Change to new-path-only vs. keep legacy-aware during transition | Keep legacy-aware: use `findFirstExistingPath` internally in both helpers | These helpers are called directly from `status/[ticketId]/route.ts` at three sites (lines 69, 281, 298). Making them new-path-only while the route is only partially migrated would silently return `null` for any legacy job whose PID file or JSONL is still at `.claude/work`, causing STARTING loops to show no activity and live IN_PROGRESS jobs to be misreported as STOPPED |
| `saveClaudeState`/`restoreClaudeState` scope | Save only `.closedloop-ai/work` vs save both `.claude` and `.closedloop-ai` | Save both `.claude` (tracked repo files + Claude CLI settings) AND `.closedloop-ai` (ClosedLoop work state) separately during worktree recreation | The `.claude/` directory in a worktree contains both tracked repo files (settings.json, agents/, scripts/) which git restores automatically, AND runtime files (.closedloop/, tmp/, work/). Both must survive a worktree swap |
| Restore merge depth | Shallow `readdirSync` copy (current) vs recursive copy | Recursive copy using `cpSync` with `recursive: true` for `.closedloop-ai/work` | The current `readdirSync` + `copyFileSync` loop only copies direct children, silently dropping `attachments/`, `comment-chats/`, `.learnings/pending/` and other nested subdirectories |
| Restore non-`work/` runtime files under `.claude/` | Merge only `.claude/work` vs merge entire `.claude/` tree | Recursively restore any `.claude/` child that is absent in the new worktree after git recreates tracked files | `.claude/` contains runtime state beyond `work/`: `settings.local.json`, `.closedloop/`, `tmp/`, `cr-cache-*`. When git recreates tracked `.claude/` files, these are absent; merging only `work/` silently drops them |
| Attachment regex | Update regex to match new path only vs match both old and new | Regex updated to match `(?:\.claude\/work\/|\.closedloop-ai\/work\/)?attachments/` | Plans written with the old path exist on disk; the regex must handle both during transition |
| run-loop.sh STATE_FILE | Keep at `.claude/closedloop-loop.local.md` vs move to `.closedloop-ai/closedloop-loop.local.md` | Move to `.closedloop-ai/closedloop-loop.local.md` | Claude now protects `.claude/`; state file writes there will fail |
| cancel-code.md allowed-tools | Keep tool list pointing to `.claude/closedloop-loop.local.md` | Update to `.closedloop-ai/closedloop-loop.local.md` | `allowed-tools` is enforced at the Claude CLI level; the command will fail to read/delete the file if the path is wrong |
| Global chat history location | Keep at `~/.claude/.closedloop/chats/` vs move to `~/.closedloop-ai/chats/` | Move write destination to `~/.closedloop-ai/chats/`; keep `~/.claude/.closedloop/chats/` as legacy migration source (read once, then move) | `ticket-chat`, `terminal-chat`, and `run-viewer-chat` all call `saveChatHistory()` which writes to `~/.claude/.closedloop/chats/`. These writes must stop |
| Global chat migration precedence | Call `migrateLegacyChatHistory` twice vs explicit if-else chain | Explicit precedence: new path wins; if absent check `.closedloop` path; if absent check `.symphony` path | `migrateLegacyChatHistory` deletes the source when the destination already exists. Calling it twice against the same destination when both legacy sources exist would silently unlink whichever source runs second |

## Tasks

### Phase 1: Add `WORK_SUBDIR` constant and helpers in symphony-alpha

- [ ] **T-1.1**: In `apps/app/lib/engineer/process-utils.ts`, add an exported constant at the bottom of the file:
  ```ts
  export const WORK_SUBDIR = ".closedloop-ai/work";
  ```
  Then change the three inline `join(worktreeDir, ".claude", "work", ...)` expressions inside `readProcessPid`, `readLaunchMetadata`, and `writeLaunchMetadata` to use `join(worktreeDir, ".closedloop-ai", "work", ...)`.

  **Additionally**, update `readProcessPid` to use `findFirstExistingPath` internally so it remains legacy-aware during the migration window. The helper is called directly from `status/[ticketId]/route.ts` at three sites (lines 69, 281, and 298); making it new-path-only would silently return `null` for any legacy job whose PID file is still at `.claude/work/process.pid`:
  ```ts
  export async function readProcessPid(
    worktreeDir: string
  ): Promise<number | null> {
    const newPidPath = join(worktreeDir, ".closedloop-ai", "work", "process.pid");
    const oldPidPath = join(worktreeDir, ".claude", "work", "process.pid");
    const pidPath = findFirstExistingPath(newPidPath, oldPidPath);

    if (!pidPath) {
      return null;
    }

    try {
      const pidContent = await readFile(pidPath, "utf-8");
      const pid = Number.parseInt(pidContent.trim(), 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }
  ```
  Note: `findFirstExistingPath` is added in T-1.3; sequence T-1.3 before T-1.1 or add them in the same edit.

- [ ] **T-1.2**: Add the migration helper at the bottom of `process-utils.ts`. The function migrates state on disk for jobs that have stopped; it does NOT allow running processes to continue. Add `renameSync` to the `node:fs` import list:
  ```ts
  /**
   * One-time migration: if .claude/work exists but .closedloop-ai/work does not,
   * AND no live process is writing to the old path (caller must verify this),
   * rename the tree. Safe to call at both launch and write-first-access time.
   * Do NOT call from pure read handlers that accept raw caller-supplied paths.
   */
  export function migrateWorkDirIfNeeded(worktreeDir: string): void {
    const oldDir = join(worktreeDir, ".claude", "work");
    const newDir = join(worktreeDir, ".closedloop-ai", "work");
    if (existsSync(oldDir) && !existsSync(newDir)) {
      mkdirSync(join(worktreeDir, ".closedloop-ai"), { recursive: true });
      renameSync(oldDir, newDir);
    }
  }
  ```

- [ ] **T-1.3**: Add a `findFirstExistingPath` helper at the bottom of `process-utils.ts` for read-only dual-path lookups. This is the same pattern already used in `closedloop-electron`'s `symphony-utils.ts`:
  ```ts
  /**
   * Return the first path that exists on disk, or null if none exist.
   * Use this in read-only handlers to transparently support both legacy
   * (.claude/work) and new (.closedloop-ai/work) locations without renaming.
   */
  export function findFirstExistingPath(...paths: string[]): string | null {
    for (const p of paths) {
      if (existsSync(p)) {
        return p;
      }
    }
    return null;
  }
  ```

- [ ] **T-1.4**: In `apps/app/app/api/engineer/symphony/launch/route.ts`, add a legacy-job force-kill step before the main launch logic. Before calling `migrateWorkDirIfNeeded`, check for a PID file at the old location (`.claude/work/process.pid`). If found, read the PID and check liveness. If alive, send `SIGTERM`, wait 500 ms, then send `SIGKILL` to the process group if still alive (matching the existing pattern in `kill/route.ts` lines 207-219). Delete the old PID file and return a `409 Conflict` response with the message: `"A job started before the .closedloop-ai migration is still running. It has been stopped -- please re-launch."` If dead, delete the stale PID file and continue to migration. Call `migrateWorkDirIfNeeded(worktreeDir)` after the force-kill/cleanup step so stopped worktrees with old state are migrated transparently at launch.

### Phase 2: Update all `.claude/work` path construction in symphony-alpha

Each task below changes `join(x, ".claude", "work", ...)` to `join(x, ".closedloop-ai", "work", ...)` (or equivalent when spread across multiple `join` arguments).

**Migration strategy by handler type:**
- **Launch handler**: `migrateWorkDirIfNeeded` is already called from T-1.4 before any path reads.
- **Write handlers** (upload, chat, comment-chat, etc.): Use the shared write-handler preflight pattern (described below) at the top of each handler. The worktreeDir is always derived from `getWorktreeParentDir()` (a trusted config path, not a raw user-supplied string), so migration is safe after the PID check.
- **Pure read handlers that derive worktreeDir from config**: Use `findFirstExistingPath(newPath, legacyPath)` instead of the preflight pattern. This covers handlers like `status/[ticketId]/route.ts`, `logs/`, `plan/`, `judges/`, `chat-history/`, etc. that only read files and should not mutate the directory structure.
- **Flat `status/route.ts`** (raw `workDir` query param, no config validation): Use `findFirstExistingPath` only. Do NOT call `migrateWorkDirIfNeeded` here -- the `workDir` param is caller-supplied and unvalidated against the configured worktree parent, making a rename unsafe.
- **Kill/stop handlers**: Use dual-path lookup in `resolvePid` and `cancelLoop` (see T-2.4 and T-2.16 below).

**Write-handler preflight pattern** (apply to every task that previously said "call `migrateWorkDirIfNeeded` at top"):
```ts
// Preflight: use new dir if it exists, else check for a live legacy job first
const newWorkDir = join(worktreeDir, ".closedloop-ai", "work");
const oldWorkDir = join(worktreeDir, ".claude", "work");
if (!existsSync(newWorkDir) && existsSync(oldWorkDir)) {
  const legacyPidPath = join(oldWorkDir, "process.pid");
  if (existsSync(legacyPidPath)) {
    const rawPid = readFileSync(legacyPidPath, "utf-8").trim();
    const legacyPid = Number.parseInt(rawPid, 10);
    if (!Number.isNaN(legacyPid) && isProcessRunning(legacyPid)) {
      return NextResponse.json(
        { error: "A job started before the .closedloop-ai migration is still running. Stop it first, then retry." },
        { status: 409 }
      );
    }
  }
  migrateWorkDirIfNeeded(worktreeDir);
}
```
Import `readFileSync` and `isProcessRunning` as needed. For routes that already import those utilities, no additional imports are required.

- [ ] **T-2.1**: `apps/app/app/api/engineer/symphony/launch/route.ts` - 6 occurrences:
  - `createPrdFile`: `claudeWorkDir = join(workDir, ".claude", "work")`
  - `getPrdFileIfExists`: `prdFile = join(worktreeDir, ".claude", "work", "prd.md")`
  - `alreadyRunning` branch log file: `join(worktreeDir, ".claude", "work", "closedloop-launch.log")`
  - Two PID writes: `join(worktreeDir, ".claude", "work", "process.pid")`
  - `spawnSymphony`: `claudeWorkDir = join(workDir, ".claude", "work")`
  - Migration call from T-1.4 already handles the launch entry point.

- [ ] **T-2.2**: `apps/app/app/api/engineer/symphony/status/route.ts` - 1 occurrence:
  - This route takes a raw `workDir` query param -- do NOT call `migrateWorkDirIfNeeded` here.
  - Change: replace `const stateFile = join(workDir, ".claude", "work", "state.json")` with `findFirstExistingPath(join(workDir, ".closedloop-ai", "work", "state.json"), join(workDir, ".claude", "work", "state.json"))`.
  - If `findFirstExistingPath` returns null, return `{ isRunning: false, reason: "state.json not found" }` (same behavior as today's `existsSync` miss). If it returns a path, read from that path.

- [ ] **T-2.3**: `apps/app/app/api/engineer/symphony/status/[ticketId]/route.ts` - 6 occurrences (logPath, lockPath, statePath x2, planPath, agentTypesDir).
  - This handler derives `worktreeDir` from config (safe). Use `findFirstExistingPath` for each read path: try `.closedloop-ai/work/<file>` first, fall back to `.claude/work/<file>`. Write paths (none in this route -- it is read-only) would use the new path directly.
  - The `readProcessPid` and `readLiveActivity` calls in this route (lines 69, 281, 298) are addressed in T-1.1 and T-3.1 respectively -- those helpers are made legacy-aware internally so no route-level changes are needed at those call sites.

- [ ] **T-2.4**: `apps/app/app/api/engineer/symphony/kill/route.ts` - kill route requires special handling to preserve legacy job support:
  - `resolvePid`: currently reads PID only from `join(worktreeDir, ".claude", "work", "process.pid")`. Change to check new path first, then fall back to legacy: `findFirstExistingPath(join(worktreeDir, ".closedloop-ai", "work", "process.pid"), join(worktreeDir, ".claude", "work", "process.pid"))`. If neither exists, return `{ noPidFile: true, worktreeDir }` as today.
  - `clearAgentTypes`: update `agentTypesDir` to use `.closedloop-ai/work/.agent-types`. Add a secondary check for the old `.claude/work/.agent-types` location and clear it too if present (best-effort).
  - `markStateAsStopped`: update `statePath` to use `.closedloop-ai/work/state.json`. Before writing, also apply the write-handler preflight pattern so the directory exists at the new path. This ensures `writeFileSync` can succeed for jobs whose work dir has never been accessed via the new path.

- [ ] **T-2.5**: `apps/app/app/api/engineer/symphony/logs/[ticketId]/route.ts` - 2 occurrences (jsonlFile, legacyLogFile).
  - Use `findFirstExistingPath` for BOTH log candidates. For `jsonlFile` (`claude-output.jsonl`): `findFirstExistingPath(join(worktreeDir, ".closedloop-ai", "work", "claude-output.jsonl"), join(worktreeDir, ".claude", "work", "claude-output.jsonl"))`. For `legacyLogFile` (the text-format fallback): use the same new-then-old directory fallback -- the "legacy" label refers to the file format (text vs JSONL), not the directory. After migration, text logs live under `.closedloop-ai/work`. Note: the reader currently looks for `symphony-launch.log` while the writer in `launch/route.ts` emits `closedloop-launch.log`; confirm and align the filename in the same edit. Use `findFirstExistingPath(join(worktreeDir, ".closedloop-ai", "work", "<logFilename>"), join(worktreeDir, ".claude", "work", "<logFilename>"))` for whichever filename is canonical. If both `findFirstExistingPath` calls return null, fall through to the existing "not found" response.

- [ ] **T-2.6**: `apps/app/app/api/engineer/symphony/plan/[ticketId]/route.ts` - 2 occurrences (planPath, planMdPath).
  - Use `findFirstExistingPath(newPlanPath, oldPlanPath)` for each.

- [ ] **T-2.7**: `apps/app/app/api/engineer/symphony/judges/[ticketId]/route.ts` - 1 occurrence (judgesPath).
  - Use `findFirstExistingPath(newPath, oldPath)`.

- [ ] **T-2.8**: `apps/app/app/api/engineer/symphony/attachments/[ticketId]/[...path]/route.ts` - 2 occurrences (filePath construction, attachmentsDir).
  - Use `findFirstExistingPath` to locate the attachments dir under either `.closedloop-ai/work/attachments` or `.claude/work/attachments`.

- [ ] **T-2.9**: `apps/app/app/api/engineer/symphony/upload/[ticketId]/route.ts` - 1 occurrence (attachmentsDir).
  - This is a write handler. Apply the write-handler preflight pattern at the top before constructing `attachmentsDir`. Then use the new path `join(worktreeDir, ".closedloop-ai", "work", "attachments")`.

- [ ] **T-2.10**: `apps/app/app/api/engineer/symphony/chat-history/[ticketId]/route.ts` - 1 occurrence.
  - Use `findFirstExistingPath(newChatPath, oldChatPath)` for the read. For the write path, use `.closedloop-ai/work`. Apply the write-handler preflight pattern at the top since this route can also write.

- [ ] **T-2.11**: `apps/app/app/api/engineer/symphony/chat/[ticketId]/route.ts` - 1 occurrence (claudeWorkDir).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.12**: `apps/app/app/api/engineer/symphony/comment-chat/[commentId]/route.ts` - 1 occurrence (claudeWorkDir).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.13**: `apps/app/app/api/engineer/symphony/extract-learnings/route.ts` - 1 occurrence (claudeWorkDir).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.14**: `apps/app/app/api/engineer/symphony/learnings-status/[ticketId]/route.ts` - 1 occurrence.
  - Read handler. Use `findFirstExistingPath(newPath, oldPath)`.

- [ ] **T-2.15**: `apps/app/app/api/engineer/symphony/process-learnings/route.ts` - 2 occurrences (claudeWorkDir).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.16**: `apps/app/app/api/engineer/symphony/kill/route.ts` `cancelLoop` function (line 107): currently reads `join(worktreeDir, ".claude", "closedloop-loop.local.md")`. After Phase 9, run-loop.sh writes STATE_FILE to `.closedloop-ai/closedloop-loop.local.md`. This function must try the new path first, then fall back to the old path (so legacy jobs running before the claude-plugins update can still be cancelled):
  ```ts
  function cancelLoop(worktreeDir: string): boolean {
    const newStateFile = join(worktreeDir, ".closedloop-ai", "closedloop-loop.local.md");
    const oldStateFile = join(worktreeDir, ".claude", "closedloop-loop.local.md");
    const stateFile = existsSync(newStateFile) ? newStateFile
      : existsSync(oldStateFile) ? oldStateFile
      : null;
    if (!stateFile) { return false; }
    try {
      unlinkSync(stateFile);
      return true;
    } catch {
      return false;
    }
  }
  ```

- [ ] **T-2.17**: `apps/app/app/api/engineer/symphony/sessions/unread-count/route.ts` - 1 occurrence (chatPath).
  - Currently reads `chatPath = join(worktreePath, ".claude", "work", "chat-history.json")` with no migration. Use `findFirstExistingPath(join(worktreePath, ".closedloop-ai", "work", "chat-history.json"), join(worktreePath, ".claude", "work", "chat-history.json"))`. If neither path exists, continue (same as today's `existsSync` miss).

- [ ] **T-2.18**: `apps/app/app/api/engineer/symphony/record-learning-use/route.ts` - 1 occurrence (claudeWorkDir).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.19**: `apps/app/app/api/engineer/codex/argue/[ticketId]/route.ts` - 1 occurrence (codex-debate.json path).
  - Read-then-write handler. Apply the write-handler preflight pattern at the top, then use new path.

- [ ] **T-2.20**: `apps/app/app/api/engineer/codex/chat/[ticketId]/route.ts` - 1 occurrence (claudeWorkDir).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.21**: `apps/app/app/api/engineer/codex/finding-chat/[findingId]/route.ts` - 1 occurrence (claudeWorkDir).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.22**: `apps/app/app/api/engineer/codex/review-findings/[ticketId]/route.ts` - 1 occurrence.
  - Read-then-write. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.23**: `apps/app/app/api/engineer/codex/review/[ticketId]/route.ts` - 3 occurrences (workDir x3).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.24**: `apps/app/app/api/engineer/codex/status/[ticketId]/route.ts` - 2 occurrences (workDir x2).
  - Read handler. Use `findFirstExistingPath(newPath, oldPath)` for each read.

- [ ] **T-2.25**: `apps/app/app/api/engineer/codex/stop/[ticketId]/route.ts` - 1 occurrence.
  - Stop handler (writes STOPPED status). Apply the write-handler preflight pattern at top before writing, then use new path.

- [ ] **T-2.26**: `apps/app/app/api/engineer/deploy/route.ts` - 1 occurrence (claudeWorkDir).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.27**: `apps/app/app/api/engineer/deploy/status/[ticketId]/route.ts` - 1 occurrence (claudeWorkDir).
  - Read handler. Use `findFirstExistingPath(newPath, oldPath)`.

- [ ] **T-2.28**: `apps/app/app/api/engineer/git/worktree/route.ts` - 1 occurrence (workDir).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-2.29**: `apps/app/app/api/engineer/ticket-chat/route.ts` - migrate global chat history path. In `getChatHistoryPath()`, change the return value from `join(homedir(), ".claude", ".closedloop", "chats", ...)` to `join(homedir(), ".closedloop-ai", "chats", ...)`. In `loadChatHistory()`, replace the two-level `migrateLegacyChatHistory` calls with an explicit precedence chain (see note below). `saveChatHistory()` only needs the new path; no other changes required.

- [ ] **T-2.30**: `apps/app/app/api/engineer/terminal-chat/route.ts` - migrate global chat history path. Change `HISTORY_PATH` constant from `join(homedir(), ".claude", ".closedloop", "chats", "_terminal", "chat-history.json")` to `join(homedir(), ".closedloop-ai", "chats", "_terminal", "chat-history.json")`. Add `CLOSEDLOOP_HISTORY_PATH` constant for `join(homedir(), ".claude", ".closedloop", "chats", "_terminal", "chat-history.json")`. In `loadChatHistory()`, apply the explicit precedence chain (see note below). `LEGACY_HISTORY_PATH` (the `.symphony` path) stays as-is. `saveChatHistory()` requires no other changes.

- [ ] **T-2.31**: `apps/app/app/api/engineer/run-viewer-chat/route.ts` - migrate global chat history path. Same pattern as T-2.30: change `HISTORY_PATH` to `~/.closedloop-ai/chats/_run-viewer/chat-history.json`, add `CLOSEDLOOP_HISTORY_PATH` for the old `.claude/.closedloop/chats/` path, and apply the explicit precedence chain.

  **Explicit precedence for T-2.29 through T-2.31** -- implement this logic in each `loadChatHistory()`:
  ```ts
  // Precedence: new path wins; if absent check .closedloop; if absent check .symphony.
  // Never call migrateLegacyChatHistory twice against the same destination:
  // the helper deletes the source when dest exists, so a second call would
  // silently unlink whichever source runs second.
  if (existsSync(HISTORY_PATH)) {
    // already at new location, nothing to migrate
  } else if (existsSync(CLOSEDLOOP_HISTORY_PATH)) {
    migrateLegacyChatHistory(CLOSEDLOOP_HISTORY_PATH, HISTORY_PATH);
  } else if (existsSync(LEGACY_HISTORY_PATH)) {
    migrateLegacyChatHistory(LEGACY_HISTORY_PATH, HISTORY_PATH);
  }
  ```
  This ensures only one source is ever migrated to the destination per invocation, and the winner is always the most recent location (new > `.closedloop` > `.symphony`).

- [ ] **T-2.32**: `apps/app/app/api/engineer/learnings/route.ts` - already correct. Verify that the GET handler reads from `~/.closedloop-ai/learnings/org-patterns.toon` as the primary and `~/.claude/.learnings/org-patterns.toon` as a read-only fallback with no writes. No code change required -- mark as verified.

### Phase 3: Update lib files in symphony-alpha

- [ ] **T-3.1**: `apps/app/lib/engineer/jsonl-activity.ts` - 1 occurrence (`join(worktreeDir, ".claude", "work", "claude-output.jsonl")`).
  - Update to use `findFirstExistingPath` internally so the helper remains legacy-aware. `readLiveActivity` is called from `status/[ticketId]/route.ts` line 298 (the no-state-json branch). Making it new-path-only would cause `liveActivity` to return `undefined` for any legacy job still writing JSONL to `.claude/work`, causing the STARTING phase to show no activity indicator even when the process is actively running:
  ```ts
  const newJsonlPath = join(worktreeDir, ".closedloop-ai", "work", "claude-output.jsonl");
  const oldJsonlPath = join(worktreeDir, ".claude", "work", "claude-output.jsonl");
  const jsonlPath = findFirstExistingPath(newJsonlPath, oldJsonlPath) ?? newJsonlPath;
  ```
  Import `findFirstExistingPath` from `@/lib/engineer/process-utils` (added in T-1.3). The fallback to `newJsonlPath` when neither exists means the function still returns `undefined` (stat will throw) for a totally new worktree -- same as current behavior.

- [ ] **T-3.2**: `apps/app/lib/engineer/learnings.ts` - 1 occurrence (claudeWorkDir join). Note: `getOrgPatternsContext()` already reads `~/.closedloop-ai/learnings/` as primary and `~/.claude/.learnings/` as fallback (read-only). Only update the worktree-scoped `claudeWorkDir` path, not the org-patterns read paths.

- [ ] **T-3.3**: `apps/app/lib/engineer/repos.ts` - 4 occurrences:
  - `getWorktreesWithPendingLearnings`: `pendingDir` currently hardcoded to `.claude/work/.learnings/pending`. This is a scan function (read-only). Use `findFirstExistingPath(join(worktreeDir, ".closedloop-ai", "work", ".learnings", "pending"), join(worktreeDir, ".claude", "work", ".learnings", "pending"))` to locate `pendingDir`. Update the returned `claudeWorkDir` field to use the resolved work dir (whichever exists), not the hardcoded old path. If neither exists, continue (same as today's `existsSync` miss).
  - `checkRequiredPlugins`: reads `~/.claude/plugins/installed_plugins.json` - do NOT change (this is a Claude system directory used by the Claude CLI, not a ClosedLoop work directory).
  - `getSymphonyScriptPath` / `getSelfLearningScriptPath`: read `~/.claude/plugins/cache/...` - do NOT change (same reason).

- [ ] **T-3.4**: `apps/app/lib/engineer/worktree.ts` - refactor `saveClaudeState` and `restoreClaudeState`:
  - Rename both functions to `saveWorktreeState` and `restoreWorktreeState`, updating their calls in `addWorktree`.
  - `saveWorktreeState`: save both `.claude/` and `.closedloop-ai/` to separate temp paths. Return a struct `{ claudeDir: string | null; closedloopAiDir: string | null }`. Use `renameSync` for each.
  - `restoreWorktreeState`: when `.claude/` is absent from the fresh worktree, rename the saved dir straight in (fast path). When `.claude/` already exists (git recreated tracked files like `settings.json`, `agents/`, `scripts/`), use a destination-precedence merge: for each direct child of the saved `.claude/` dir, if that child is **absent** in the destination, restore it -- either `renameSync` for a directory subtree or `copyFileSync` for a plain file. This preserves runtime-only children (`settings.local.json`, `.closedloop/`, `tmp/`, `cr-cache-*`, `work/`) without overwriting tracked files that git already restored. Use `cpSync(savedChild, destChild, { recursive: true })` for directory children so nested subdirectories under each child (`attachments/`, `comment-chats/`, `.learnings/pending/`) are preserved recursively. Delete the saved temp dir after merging. For `.closedloop-ai/work` -- always merge the saved state into the new worktree using `cpSync(savedClosedloopAiWork, destClosedloopAiWork, { recursive: true })`, then remove its temp dir. Add `cpSync` and `statSync` to the `node:fs` import list.
  - This fixes two pre-existing bugs: (1) the shallow `readdirSync` + `copyFileSync` loop silently dropped nested subdirectories like `attachments/`, `comment-chats/`, `.learnings/pending/`; (2) the merge scope was limited to `work/` only, silently dropping `settings.local.json`, `.closedloop/`, `tmp/`, and cache dirs at the `.claude/` root.

- [ ] **T-3.5**: `apps/app/app/api/engineer/symphony/process-all-learnings/route.ts`:
  - `LEGACY_STATUS_DIR = join(homedir(), ".claude", ".learnings")` - this is a true legacy path migration; keep the legacy read as-is (reads only, not writes).

### Phase 4: Update frontend attachment URL regex in symphony-alpha

- [ ] **T-4.1**: `apps/app/components/engineer/PlanViewer.tsx` line 207: Update the regex from `(?:\.claude\/work\/)?` to `(?:\.claude\/work\/|\.closedloop-ai\/work\/)?` so plans written with the old path still resolve correctly during transition.

- [ ] **T-4.2**: `apps/app/components/engineer/SymphonyChat.tsx` line 2667: Same regex update as T-4.1.

### Phase 5: Update tests in symphony-alpha

- [ ] **T-5.1**: `apps/app/lib/engineer/__tests__/process-utils.test.ts` - Update all `join(testDir, ".claude", "work", ...)` to `join(testDir, ".closedloop-ai", "work", ...)`. Add test cases for `migrateWorkDirIfNeeded`:
  - Creates `.claude/work/process.pid`, calls the function, asserts the file moved to `.closedloop-ai/work/process.pid` (stopped-worktree migration).
  - Creates `.closedloop-ai/work/process.pid` alongside `.claude/work/`, calls the function, asserts the old `.claude/work` is NOT renamed (new path already exists -- no-op).
  - Calls the function with neither path present -- no error thrown.
  Add test cases for `findFirstExistingPath`:
  - Returns first existing path when multiple are given.
  - Returns null when none exist.
  Add test cases for legacy-aware `readProcessPid`:
  - PID file exists only at `.claude/work/process.pid`: returns the PID.
  - PID file exists only at `.closedloop-ai/work/process.pid`: returns the PID.
  - Both paths exist: returns PID from `.closedloop-ai/work/process.pid` (new path wins).
  - Neither path exists: returns null.

- [ ] **T-5.2**: `apps/app/lib/engineer/__tests__/jsonl-activity.test.ts` - Update `WORK_DIR` constant from `join(TMP_DIR, ".claude", "work")` to `join(TMP_DIR, ".closedloop-ai", "work")`. Add test cases for legacy-aware `readLiveActivity`:
  - JSONL file exists only at `.claude/work/claude-output.jsonl`: `readLiveActivity` returns an activity label (not undefined).
  - JSONL file exists only at `.closedloop-ai/work/claude-output.jsonl`: `readLiveActivity` returns an activity label.
  Add test cases for the logs route text-log fallback (T-2.5):
  - Text log file exists only at `.closedloop-ai/work/<logFilename>` (no `.claude/work` copy): the route returns `{ exists: true, format: "text", content: ... }` (the file is found under the new directory).
  - Text log file exists only at `.claude/work/<logFilename>` (legacy-only scenario): the route returns `{ exists: true, format: "text", content: ... }` (the legacy fallback is honored).

- [ ] **T-5.3**: `apps/app/lib/engineer/__tests__/launch-idempotency.test.ts` - Update all `join(worktreeDir, ".claude", "work", ...)` to `join(worktreeDir, ".closedloop-ai", "work", ...)`.

- [ ] **T-5.4**: Add a `worktree.test.ts` test file in `apps/app/lib/engineer/__tests__/` covering the refactored `saveWorktreeState`/`restoreWorktreeState` from T-3.4:
  - Case: saved `.claude/work/attachments/image.png` is correctly restored into the new worktree when `.claude/` already exists (git recreated tracked files). Verifies `cpSync` recursion preserves nested subdirectories under `work/`.
  - Case: saved `.claude/settings.local.json` survives when `.claude/` already exists after `git worktree add`. The git-restored tracked `settings.json` must remain intact and the runtime-only `settings.local.json` must appear in the destination.
  - Case: saved `.claude/.closedloop/` directory survives when `.claude/` already exists. The destination `.claude/` was created by git (contains only tracked files); `.closedloop/` is absent until restored.
  - Case: saved `.closedloop-ai/work/comment-chats/IC_1234.json` survives worktree recreation.
  - Case: when neither `.claude/` nor `.closedloop-ai/` exist in the worktree, rename path is taken (normal case when dirs are absent).
  - Case: a tracked file already restored by git (`settings.json`) is NOT overwritten by the saved copy (destination-precedence for git-created files).

- [ ] **T-5.5**: Add test cases covering the global chat migration precedence for `terminal-chat`, `run-viewer-chat`, and `ticket-chat` (T-2.29 / T-2.30 / T-2.31). All three routes have their own distinct path-building and `loadChatHistory` implementations and must be tested independently.

  For **`terminal-chat`** and **`run-viewer-chat`** (fixed paths, no per-ticket subdirectory):
  - Only `.symphony` source exists: file migrated to new path.
  - Only `.closedloop` source exists: file migrated to new path.
  - Both `.symphony` and `.closedloop` exist: `.closedloop` wins (migrated), `.symphony` is not touched.
  - New path already exists: no migration, both legacy sources left intact.

  For **`ticket-chat`** (per-ticket path via `getChatHistoryPath`):
  - Only `.symphony` source exists at `~/.claude/.symphony/chats/<sanitizedId>/chat-history.json`: file migrated to new path `~/.closedloop-ai/chats/<sanitizedId>/chat-history.json`.
  - Only `.closedloop` source exists at `~/.claude/.closedloop/chats/<sanitizedId>/chat-history.json`: file migrated to new path.
  - Both `.symphony` and `.closedloop` exist: `.closedloop` wins (migrated), `.symphony` is not touched.
  - New path already exists: no migration, both legacy sources left intact.
  - Sanitized ticket ID path is preserved: `ticketId = "ENG-123 Feature"` produces `sanitizedId = "ENG-123_Feature"` and the new-path file is found at `~/.closedloop-ai/chats/ENG-123_Feature/chat-history.json` (not at the raw unsanitized ID).

- [ ] **T-5.6**: Add test cases for the kill route's dual-path PID and loop state lookup (T-2.4 / T-2.16):
  - PID file exists only at old `.claude/work/process.pid`: `resolvePid` returns the PID.
  - PID file exists only at new `.closedloop-ai/work/process.pid`: `resolvePid` returns the PID.
  - `cancelLoop` deletes the state file when it exists only at old `.claude/closedloop-loop.local.md`.
  - `cancelLoop` deletes the state file when it exists only at new `.closedloop-ai/closedloop-loop.local.md`.

- [ ] **T-5.7**: Add test cases for the write-handler preflight pattern:
  - Upload against a live legacy job (PID file at `.claude/work/process.pid`, process alive): handler returns 409 and `.claude/work` is NOT renamed.
  - Upload against a dead legacy job (PID file at `.claude/work/process.pid`, process dead): handler succeeds and `.claude/work` is migrated to `.closedloop-ai/work`.
  - Chat against a live legacy job returns 409 and does not rename the old dir.

### Phase 6: Update closedloop-electron

- [ ] **T-6.1**: In `apps/desktop/src/server/operations/symphony-utils.ts`, add an exported constant at the bottom:
  ```ts
  export const WORK_SUBDIR = ".closedloop-ai/work";
  ```
  Then update `readProcessPidSync`, `readLaunchMetadata`, and `writeLaunchMetadata` to use `.closedloop-ai/work` instead of `.claude/work`. Make `readProcessPidSync` legacy-aware using `findFirstExisting(newPidPath, oldPidPath)` -- it is called from the status handler which must remain legacy-aware during the migration window. Add a `migrateWorkDirIfNeeded` function matching T-1.2. The existing `findFirstExisting` helper is already present in this file -- use it for read-only dual-path lookups in Phase 6 tasks rather than adding a new helper.

- [ ] **T-6.2**: `apps/desktop/src/server/operations/symphony-status.ts` - already uses `findFirstExisting` for `statePath` and `resolvedPlanPath`. Extend this pattern to all remaining occurrences: pidPath, logPath, lockPath, agentTypesDir. Do NOT call `migrateWorkDirIfNeeded` here -- the status handler is read-only and the path is validated before this point.

- [ ] **T-6.3**: `apps/desktop/src/server/operations/symphony-kill.ts` - same dual-path treatment as T-2.4 / T-2.16:
  - `pidFilePath`: use `findFirstExisting(newPidPath, oldPidPath)`.
  - `stateFile` in cancel loop: check new `.closedloop-ai/symphony-loop.local.md` first, then old `.claude/symphony-loop.local.md`.
  - `agentTypesDir`: update to new path; also clear old path if present (best-effort).
  - `statePath` in `markStateAsStopped`: apply the write-handler preflight pattern before writing, then use new path.

- [ ] **T-6.4**: `apps/desktop/src/server/operations/symphony-loop.ts` - 4 occurrences: contextDir (`".claude", "context"` changes to `".closedloop-ai", "context"`), bodyFile, claudeWorkDir x2.
  - Before setting `claudeWorkDir` in the launch path: check for a PID at the old `.claude/work/process.pid` location; if found and the process is alive, send `SIGTERM`, wait 500 ms, then send `SIGKILL` to the process group if still alive (matching the existing pattern in symphony-kill). Delete the old PID file and return the same user-facing error as T-1.4. Only then call `migrateWorkDirIfNeeded(worktreeDir)`.

- [ ] **T-6.5**: `apps/desktop/src/server/operations/symphony-interactive.ts` - 5 occurrences (claudeWorkDir x2, symphony-launch.log path, prdFile path, comment-chats path).
  - Write handler. Apply the write-handler preflight pattern at top, then use new paths.

- [ ] **T-6.6**: `apps/desktop/src/server/operations/symphony-plan.ts` - 2 occurrences (plan.json, plan.md paths).
  - Read handler. Use `findFirstExisting(newPlanPath, oldPlanPath)` for each.

- [ ] **T-6.7**: `apps/desktop/src/server/operations/symphony-judges.ts` - 1 occurrence (judgesPath).
  - Read handler. Use `findFirstExisting(newPath, oldPath)`.

- [ ] **T-6.8**: `apps/desktop/src/server/operations/symphony-logs.ts` - 2 occurrences (jsonlFile, legacyLogFile).
  - Use `findFirstExisting` for BOTH log candidates. For `jsonlFile` (`claude-output.jsonl`): `findFirstExisting(join(worktreeDir, ".closedloop-ai", "work", "claude-output.jsonl"), join(worktreeDir, ".claude", "work", "claude-output.jsonl"))`. For `legacyLogFile` (`symphony-launch.log`): use the same new-then-old directory fallback -- the "legacy" label refers to the file format (text vs JSONL), not the directory. After migration, text logs live under `.closedloop-ai/work`. Use `findFirstExisting(path.join(worktreeDir, ".closedloop-ai", "work", "symphony-launch.log"), path.join(worktreeDir, ".claude", "work", "symphony-launch.log"))`. If both calls return null (no log at either location), fall through to the existing "not found" response.

- [ ] **T-6.9**: `apps/desktop/src/server/operations/symphony-sessions.ts` - 1 occurrence (workDir).
  - Use `findFirstExisting(newChatPath, oldChatPath)` for read. If a write path is involved, apply the write-handler preflight pattern first.

- [ ] **T-6.10**: `apps/desktop/src/server/operations/symphony-chat-history.ts` - 1 occurrence (chat history path join).
  - Read-then-write. Apply the write-handler preflight pattern at the top. Use new path for writes; use `findFirstExisting` for initial read location.

- [ ] **T-6.11**: `apps/desktop/src/server/operations/symphony-attachments.ts` - 1 occurrence (attachmentsDir).
  - Read handler. Use `findFirstExisting(newAttachmentsDir, oldAttachmentsDir)`.

- [ ] **T-6.12**: `apps/desktop/src/server/operations/symphony-upload.ts` - 1 occurrence (attachmentsDir).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-6.13**: `apps/desktop/src/server/operations/deploy.ts` - 2 occurrences (claudeWorkDir x2).
  - Write handler. Apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-6.14**: `apps/desktop/src/server/operations/learnings.ts` - 4 occurrences (claudeWorkDir x3, org-patterns.toon legacy path).
  - `homedir(), ".claude", ".learnings", "org-patterns.toon"` is a legacy read path; keep as-is (reads but does not write).
  - For worktree-scoped `claudeWorkDir` paths: apply the write-handler preflight pattern at top, then use `.closedloop-ai/work`.

- [ ] **T-6.15**: `apps/desktop/src/server/operations/codex.ts` - 8 occurrences (chatStatePath, workDir x4, debateStatePath, statePath, logPath, pidPath, findingsPath).
  - Read handlers: use `findFirstExisting(newPath, oldPath)`.
  - Write/stop handlers: apply the write-handler preflight pattern at top, then use new path.

- [ ] **T-6.16**: `apps/desktop/src/server/operations/metadata-routes.ts` - 1 occurrence (stateFile).
  - Read handler. Use `findFirstExisting(newStatePath, oldStatePath)`.

- [ ] **T-6.17**: `apps/desktop/src/server/operations/symphony-utils.ts` `saveClaudeState`/`restoreClaudeState` - same refactor as T-3.4:
  - Rename to `saveWorktreeState`/`restoreWorktreeState`.
  - Save both `.claude/` and `.closedloop-ai/` separately.
  - Restore: when `.claude/` is absent from the fresh worktree, rename the saved dir straight in (fast path). When `.claude/` already exists (git recreated tracked files), use destination-precedence merge: for each direct child of the saved `.claude/` dir, restore it only if that child is absent in the destination -- use `cpSync({ recursive: true })` for directory children so nested subdirectories are preserved. This fixes two bugs: (1) the shallow `readdirSync` + `copyFileSync` loop silently dropped nested subdirectories like `attachments/`, `comment-chats/`; (2) the merge scope was limited to `work/` only, dropping runtime-only files and directories at the `.claude/` root such as `settings.local.json`, `.closedloop/`, `tmp/`, and `cr-cache-*` dirs. For `.closedloop-ai/work` -- always merge using `cpSync({ recursive: true })`.
  - Update the `addWorktree` caller.

- [ ] **T-6.18**: `apps/desktop/src/main/app.ts` lines 462, 474: `path.join(os.homedir(), ".claude", "closedloop", "repos.json")` and `".claude", ".symphony", "chats"` - these are legacy migration source paths (config migration from old location). Do NOT change; they must stay as `.claude` to correctly find and migrate old config. Verify in the actual file that these are read-only.

- [ ] **T-6.19**: `apps/desktop/src/main/seed-repos-config.ts` line 34: same as T-6.18 - legacy migration source, do not change.

- [ ] **T-6.20**: `apps/desktop/src/server/operations/plugin-cache.ts` - `~/.claude/plugins/...` paths are for the Claude CLI plugin system, not ClosedLoop work state. Do NOT change.

### Phase 7: Update closedloop-electron tests

- [ ] **T-7.1**: `apps/desktop/test/symphony-utils.test.ts` - 6 occurrences of `join(dir, ".claude", "work", ...)`. Update all to `.closedloop-ai/work`. Add worktree restore test cases matching T-5.4: (1) `settings.local.json` survives when `.claude/` already exists; (2) `.closedloop/` dir survives when `.claude/` already exists; (3) nested `work/attachments/` subdirectory is preserved via `cpSync` recursion; (4) a git-tracked file already in the destination is not overwritten.

- [ ] **T-7.2**: `apps/desktop/test/gateway-server.test.ts` - ~20 occurrences. Update all `".claude", "work"` paths to `".closedloop-ai", "work"`. Also update the `".claude", "symphony-loop.local.md"` path at line 944/978 to `".closedloop-ai", "symphony-loop.local.md"`. Do NOT update `".claude", "plugins"` paths. Add test cases:
  - "legacy job can still be stopped without relaunch": set up a mock PID file at `.claude/work/process.pid`, call kill endpoint, assert the process is killed and state is written to new path.
  - "first access via upload against live legacy job returns 409": set up a mock PID file at `.claude/work/process.pid` with a live process, call upload endpoint, assert 409 and that `.claude/work` was NOT renamed.
  - "first access via upload after dead legacy job migrates state": set up `.claude/work/state.json` with a dead PID, call upload endpoint, assert `.closedloop-ai/work/attachments/` receives the file and `.claude/work` was migrated.
  - "text log found only under .closedloop-ai/work is returned by logs endpoint": create `symphony-launch.log` only at `.closedloop-ai/work/symphony-launch.log`, call GET `/api/engineer/symphony/logs/:ticketId`, assert `{ exists: true, format: "text" }`.
  - "text log found only under .claude/work (legacy) is returned by logs endpoint": create `symphony-launch.log` only at `.claude/work/symphony-launch.log`, call GET `/api/engineer/symphony/logs/:ticketId`, assert `{ exists: true, format: "text" }` (legacy fallback honored).
  - "worktree restore: `.claude/settings.local.json` survives when `.claude/` already exists after git worktree add": saved `.claude/settings.local.json` must appear in destination; git-restored `settings.json` must not be overwritten.
  - "worktree restore: `.claude/.closedloop/` survives when `.claude/` already exists after git worktree add": saved `.claude/.closedloop/` directory must appear in destination.

- [ ] **T-7.3**: `apps/desktop/test/plugin-cache.test.ts` - contains `~/.claude/plugins/cache/closedloop-ai` - this is a Claude CLI plugin path, do NOT change.

### Phase 8: Update scripts in symphony-alpha

- [ ] **T-8.1**: `scripts/claude-worktree.sh` - line 15 sets `WORKTREE_DIR="$REPO_ROOT/.claude/worktrees"`. This is a worktree parent directory, not a work state directory. Change to `WORKTREE_DIR="$REPO_ROOT/.closedloop-ai/worktrees"`. Also update line 52: the `find` command prunes `-path "$REPO_ROOT/.claude"` - update the prune to target the new path or add both to ensure the worktree dir (`.closedloop-ai`) is pruned from env file discovery.

### Phase 9: Update claude-plugins (`~/Source/claude-plugins`)

These changes are in the `closedloop-ai/claude-plugins` repo, which is a separate git repository.

- [ ] **T-9.1**: `plugins/code/scripts/run-loop.sh` lines 18-19 and additional writes:
  - Update hardcoded path constants at lines 18-19:
    ```bash
    # From:
    STATE_FILE=".claude/closedloop-loop.local.md"
    PROGRESS_LOG=".claude/closedloop-progress.log"
    # To:
    STATE_FILE=".closedloop-ai/closedloop-loop.local.md"
    PROGRESS_LOG=".closedloop-ai/closedloop-progress.log"
    ```
  - Update line 951 inside `create_state_file()`: change `mkdir -p .claude` to `mkdir -p .closedloop-ai`. This is a direct ClosedLoop write to `.claude/` that is not covered by the variable changes above -- the parent directory of `STATE_FILE` must be created here.
  - Update line 954: change the example comment from `# (e.g., /path/to/worktree/.claude/work)` to `# (e.g., /path/to/worktree/.closedloop-ai/work)`.
  - Update the comment on line 5 (`# State maintained in .claude/closedloop-loop.local.md`) to reference the new path.
  - Update help text at lines 737 and 769 that reference `.claude/closedloop-loop.local.md` and `.claude/closedloop-progress.log`.
  - After all edits, run `grep -n '\.claude' plugins/code/scripts/run-loop.sh` and confirm all remaining `.claude` references are read-only paths for the Claude CLI system (e.g., `~/.claude/plugins/`) or are within comments describing what to NOT do -- no write operations should target `.claude/`.

- [ ] **T-9.2**: `plugins/code/commands/cancel-code.md`: Update all three references to `.claude/closedloop-loop.local.md`:
  - `allowed-tools` frontmatter: change the two Bash tool paths and the Read path.
  - Body text: update all three occurrences (check-exists command, read reference, rm command).
  ```yaml
  allowed-tools: ["Bash(test -f .closedloop-ai/closedloop-loop.local.md:*)", "Bash(rm .closedloop-ai/closedloop-loop.local.md)", "Read(.closedloop-ai/closedloop-loop.local.md)"]
  ```

- [ ] **T-9.3**: `plugins/code/commands/amend-plan.md`: Update the `.claude/work` fallback default in three places:
  - Line 19: `--workdir .claude/work` example -> `--workdir .closedloop-ai/work`
  - Line 21 comment: `# Auto-detect from $CLOSEDLOOP_WORKDIR or .claude/work` -> `...or .closedloop-ai/work`
  - Line 25: `--workdir .claude/work --state-file .claude/work/amend-session.json` -> new paths
  - Line 30 doc: `defaults to `.claude/work`` -> `.closedloop-ai/work`
  - Lines 62-64: the three-tier fallback description
  - Line 396: the `"run_dir": ".claude/work"` example JSON

- [ ] **T-9.4**: `plugins/code/README.md`: Update documentation references to `.claude/work` and `.claude/closedloop-loop.local.md`:
  - Line 85: `--workdir <path>` description default
  - Line 103: cancel command description
  - Lines 353, 412-428: usage examples showing `mkdir .claude/work`, `cp requirements.md .claude/work/prd.md`, `/code:code .claude/work`
  - Line 737 / 769: help text that echoes `grep '^iteration:' .claude/closedloop-loop.local.md` and `tail -20 .claude/closedloop-progress.log`

## Risks

- **Legacy running processes**: Jobs launched before this deployment write their state to `.claude/work`. They cannot be migrated in-flight. The force-kill logic in T-1.4 / T-6.4 handles this at the next launch attempt. The dual-path lookup in kill/stop routes (T-2.4, T-2.16, T-6.3) ensures legacy jobs can be stopped before they are re-launched, without requiring a re-launch first.
- **Write handlers against live legacy jobs**: Write handlers (upload, chat, etc.) now apply a preflight PID check before calling `migrateWorkDirIfNeeded`. If a user accesses a write endpoint before using launch/kill, the handler will detect the live process, return 409, and leave `.claude/work` intact. The user is prompted to stop the job first.
- **Read routes after cutover**: After Phase 2 rewrites all read paths, stopped/completed worktrees with data still at `.claude/work` will be found via `findFirstExistingPath` fallbacks. Write routes apply the preflight + migrate pattern, so the first write action atomically migrates the directory before writing to the new location (assuming no live process blocks).
- **Status route consistency**: `readProcessPid` (T-1.1) and `readLiveActivity` (T-3.1) are made legacy-aware internally, so the `status/[ticketId]/route.ts` call sites at lines 69, 281, and 298 transparently handle both legacy and new paths without any route-level change.
- **Global chat history continuity**: After T-2.29 through T-2.31 move the write destination to `~/.closedloop-ai/chats/`, existing sessions in `~/.claude/.closedloop/chats/` will be migrated on first load via the explicit precedence chain. If migration fails (permissions, etc.), the user starts a fresh session -- they do not lose prior messages at the old location, they just cannot resume the prior Claude session.
- **run-loop.sh STATE_FILE**: The `STATE_FILE` in `run-loop.sh` is hardcoded at line 18. It is not passed by the server as an env var -- it is the loop's own internal state path. This must be updated in Phase 9 in coordination with deploying the rest of the changes. The kill route's dual-path lookup in T-2.16 provides a safety window: it will find the state file at either the old or new path during the transition, so the kill route does not break if Phase 9 ships slightly ahead of or behind Phases 1-8.
- **run-loop.sh `mkdir -p .claude`**: Line 951 is inside `create_state_file()` which runs every time a new loop is started. After T-9.1 this becomes `mkdir -p .closedloop-ai`. If Phase 9 ships without this specific line change, every new loop start will create a `.claude/` directory in the worktree (a protected location), causing Claude CLI to block the write.
- **cancel-code.md allowed-tools enforcement**: Claude CLI enforces the `allowed-tools` list at the session level. If `cancel-code.md` is not updated (T-9.2), the cancel command will silently fail to find the state file even if the rest of the migration is complete.
- **Two-repo coordination (symphony-alpha + closedloop-electron)**: Both must be updated together. Deploying one without the other causes mismatches in LocalElectron mode. For CloudRelay the next.js app drives itself.
- **Three-repo coordination (+ claude-plugins)**: Phase 9 changes must ship alongside or after Phases 1-8. The dual-path kill route (T-2.16) provides a safety window during the transition so that jobs running with either the old or new STATE_FILE path can be cancelled.

## Critical Files for Implementation

- `apps/app/lib/engineer/process-utils.ts` - add `WORK_SUBDIR` constant, `migrateWorkDirIfNeeded`, and `findFirstExistingPath` helpers; update 3 path joins; make `readProcessPid` legacy-aware with `findFirstExistingPath`
- `apps/app/lib/engineer/jsonl-activity.ts` - make `readLiveActivity` legacy-aware with `findFirstExistingPath` (import from process-utils)
- `apps/app/lib/engineer/worktree.ts` - refactor save/restore to preserve both `.claude` and `.closedloop-ai`; fix shallow-copy bug with `cpSync`
- `apps/app/lib/engineer/repos.ts` - update `getWorktreesWithPendingLearnings` to use `findFirstExistingPath` for dual-path scan
- `apps/app/app/api/engineer/symphony/launch/route.ts` - largest file; 6 path changes + SIGTERM/SIGKILL legacy-job check + migration call
- `apps/app/app/api/engineer/symphony/kill/route.ts` - dual-path lookup in `resolvePid`, `cancelLoop`, `clearAgentTypes`, and `markStateAsStopped`
- `apps/app/app/api/engineer/symphony/status/route.ts` - `findFirstExistingPath` only (raw `workDir` param, no rename)
- `apps/app/app/api/engineer/symphony/status/[ticketId]/route.ts` - `findFirstExistingPath` for 6 explicit read paths; `readProcessPid` and `readLiveActivity` call sites require no route-level changes (helpers are made legacy-aware in T-1.1 and T-3.1)
- `apps/app/app/api/engineer/symphony/upload/[ticketId]/route.ts` - write-handler preflight pattern; new path for attachmentsDir
- `apps/app/app/api/engineer/symphony/chat/[ticketId]/route.ts` - write-handler preflight pattern; new path for claudeWorkDir
- `apps/app/app/api/engineer/symphony/sessions/unread-count/route.ts` - `findFirstExistingPath` for `chatPath`
- `apps/app/app/api/engineer/ticket-chat/route.ts` - global chat history write path; explicit three-way precedence chain
- `apps/app/app/api/engineer/terminal-chat/route.ts` - global chat history write path; explicit three-way precedence chain
- `apps/app/app/api/engineer/run-viewer-chat/route.ts` - global chat history write path; explicit three-way precedence chain
- `apps/app/components/engineer/PlanViewer.tsx` - regex must match both old and new paths
- `apps/app/components/engineer/SymphonyChat.tsx` - same regex update
- `apps/desktop/src/server/operations/symphony-utils.ts` - add `WORK_SUBDIR` constant + `migrateWorkDirIfNeeded`; make `readProcessPidSync` legacy-aware; refactor save/restore; fix shallow-copy bug
- `apps/desktop/src/server/operations/symphony-loop.ts` - includes `.claude/context` path + SIGTERM/SIGKILL legacy-job logic
- `apps/desktop/src/server/operations/symphony-kill.ts` - dual-path lookup for PID, loop state file, agent types, and state write
- `apps/desktop/src/server/operations/codex.ts` - highest concentration (~8 occurrences)
- `apps/desktop/test/gateway-server.test.ts` - ~20 test fixture paths to update + new legacy-stop, live-legacy-409, and first-write-migration test cases
- `plugins/code/scripts/run-loop.sh` - STATE_FILE and PROGRESS_LOG constants (lines 18-19), `mkdir -p .claude` write (line 951), and example comment (line 954)
- `plugins/code/commands/cancel-code.md` - allowed-tools list uses hardcoded path
- `plugins/code/commands/amend-plan.md` - fallback default references `.claude/work`
