# Bug: Codex Chat Session State Is Not Isolated Per Context

## Status: Open — Not Yet Fixed

## Summary

`codex-chat.json` (the file that stores the Codex CLI session ID for resuming conversations) is keyed only by worktree directory. All Codex chat interactions that resolve to the same worktree — regardless of which PR comment, general chat, or review chat initiated them — read and write the same session file. This causes cross-context session contamination: a Codex session started for Comment A on PR #42 will be resumed when the user sends a message for Comment B on the same PR, or from the general symphony chat, or from the review chat pane.

## Affected Route

`apps/app/app/api/engineer/codex/chat/[ticketId]/route.ts`

## Root Cause

The session state file path is determined at lines 80-87:

```
chatStatePath = join(worktreeDir, ".claude", "work", "codex-chat.json")
```

There is no component in this path for:
- `commentId` (which PR comment is being addressed)
- Chat context type (comment chat vs general symphony chat vs review chat)
- Any other discriminator

All callers that resolve to the same `worktreeDir` share one session file.

## How Worktree Resolution Works

`getWorktreeDir` (route lines 52-76):
- If `branchName` AND `prNumber` are both provided: calls `resolveWorktreeForPR()` which returns a worktree like `<repoName>-pr-<prNumber>`. All comments on the same PR resolve to the same worktree.
- Otherwise (legacy path): uses `<repoName>-<sanitizedTicketId>` or falls back to the base repo.

## Callers That Share the Session File

Four call sites POST to this route. All resolve to the same `codex-chat.json` when they share a worktree:

### 1. CommentChat.tsx `sendToCodex` (line 269)
- URL: `/api/engineer/codex/chat/${ticketId}?repo=${repoPath}`
- Passes: `branchName`, `prNumber`, `commentContext`, `activeTab: "comments"`, `isForward`
- ticketId format: `pr-<prNumber>` (set by PRBrowserDialog)
- `commentId` is NOT passed to the route — only used client-side for saving messages
- Triggered by: user typing `@codex`, "Forward to Codex" button, auto-start for `autoProvider="codex"` comments, conferral

### 2. SymphonyChat.tsx `sendToCodex` (line 475)
- URL: `/api/engineer/codex/chat/${ticketId}?repo=${repoPath}`
- Passes: `activeTab`, `contextRepoPaths`, `isForward`, `model`
- Does NOT pass: `branchName`, `prNumber`, `commentContext`
- ticketId format: ticket ID like `AI-374`
- Falls to legacy worktree path (no branchName/prNumber)

### 3. use-review-chat.ts `buildChatRequestForProvider` (line 145)
- URL: `/api/engineer/codex/chat/${ticketId}?repo=${repoPath}`
- Passes: `chatHistory`, `repoPath`, `activeTab: "plan"`
- Does NOT pass: `branchName`, `prNumber`, `commentContext`
- Falls to legacy worktree path

### 4. use-codex-debate.ts — NOT affected (uses separate route)
- Uses `/api/engineer/codex/argue/[ticketId]` with its own state file `codex-debate.json`
- Has the same worktree-level isolation problem but less severe since debates reset on fresh start

## Reproduction Steps

1. Open a PR with multiple comments in the engineer dashboard
2. Click "Fix with Claude" on Comment A — Claude responds
3. Click "Forward to Codex" — Codex starts a new session, `codex-chat.json` stores its session ID
4. Navigate to Comment B on the same PR
5. Click "Forward to Codex" — the route finds the existing session ID from step 3 and runs `codex exec resume <sessionId>`, resuming Comment A's Codex thread with Comment B's prompt
6. Codex responds in the context of Comment A's conversation, not Comment B's

## Impact

- Codex responses may reference the wrong comment, wrong code context, or wrong conversation history
- Session state from one comment can be overwritten by another, breaking resume for both
- When resume fails (stale session), the state file is deleted (`unlinkSync` at route line 636), resetting session state for ALL comments on that PR
- The `messageCount` counter is shared across all contexts, making it meaningless

## Existing Correct Implementation for Reference

The `finding-chat` route (`apps/app/app/api/engineer/codex/finding-chat/[findingId]/route.ts`) correctly isolates by context. It stores state at:

```
<worktreeDir>/.claude/work/finding-chats/<findingId>.json
```

Each finding gets its own session file keyed by `findingId`.

## Suggested Fix

Pass a `chatContextId` through the request body and incorporate it into the state file path. The context ID should be:
- `comment-<commentId>` for PR comment chats (CommentChat.tsx)
- `review` for review chat pane (use-review-chat.ts)
- `general` for symphony general chat (SymphonyChat.tsx)

State file path becomes:
```
<worktreeDir>/.claude/work/codex-chat-<chatContextId>.json
```

### Changes Required

1. **Route** (`apps/app/app/api/engineer/codex/chat/[ticketId]/route.ts`):
   - Add `chatContextId?: string` to `ChatRequest` type (line 35)
   - Modify `getWorkPaths` to accept and use `chatContextId` in the filename (line 80)
   - Default to `"default"` if not provided for backwards compatibility

2. **CommentChat.tsx** (line 308):
   - Add `chatContextId: \`comment-${commentId}\`` to the fetch body

3. **SymphonyChat.tsx** (line 519):
   - Add `chatContextId: "general"` to the fetch body

4. **use-review-chat.ts** (line 145):
   - Add `chatContextId: "review"` to the request config

5. **Migration**: Existing `codex-chat.json` files can remain — they'll be used as fallback for `chatContextId: "default"`. New context-specific files will be created alongside them.

## Related Files

| File | Role |
|------|------|
| `apps/app/app/api/engineer/codex/chat/[ticketId]/route.ts` | Route with shared session state |
| `apps/app/components/engineer/CommentChat.tsx` | PR comment chat UI — calls sendToCodex |
| `apps/app/components/engineer/SymphonyChat.tsx` | General chat UI — calls sendToCodex |
| `apps/app/hooks/engineer/use-review-chat.ts` | Review chat hook — calls codex chat route |
| `apps/app/hooks/engineer/use-codex-debate.ts` | Debate hook — uses separate argue route (same worktree issue) |
| `apps/app/lib/engineer/worktree.ts` | `resolveWorktreeForPR` — worktree path resolution |
| `apps/app/app/api/engineer/codex/finding-chat/[findingId]/route.ts` | Reference implementation with correct per-context isolation |
| `apps/app/app/api/engineer/codex/argue/[ticketId]/route.ts` | Debate route — separate state file, same worktree-level issue |
