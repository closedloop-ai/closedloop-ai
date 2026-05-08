# Agent-Powered Comment Resolution

**Owner:** Product | **Status:** Draft | **Target:** TBD

---

## Summary

Allow document authors to select unresolved Liveblocks comment threads on an artifact and have an AI agent automatically incorporate the requested changes into the document. The agent reads each selected comment, edits the document content accordingly, resolves the thread, and appends open questions for ambiguous feedback. This reduces the manual effort of addressing review comments and accelerates the review-to-approval cycle.

---

## Context

### Problem

When reviewers leave comments on artifacts (PRDs, Implementation Plans, Templates), the document author must manually:

1. Read each comment thread
2. Interpret what change is being requested
3. Locate the relevant section in the document
4. Make the edit
5. Resolve the thread

This is tedious and time-consuming, especially on documents with many review comments. Authors context-switch between reading feedback and editing, slowing down the review-to-approval loop.

### Hypothesis

We believe that an AI agent that automatically incorporates comment feedback into documents will reduce the time authors spend resolving comments by 50%+ and drive adoption among 60%+ of active document authors within the first month.

### Personas

- **Primary:** Document Author — writes PRDs, implementation plans, or templates; receives review comments and needs to address them efficiently before approval.
- **Secondary:** Reviewer — leaves comments on documents; benefits indirectly from faster turnaround on feedback incorporation.

---

## Scope

### In (MVP)

- Select individual comment threads to resolve via agent
- "Resolve All" option to batch-process all unresolved threads on a document
- Agent reads comment content + anchored text context, edits the document directly
- App UI resolves Liveblocks threads client-side after agent successfully incorporates changes
- Ambiguous or unclear comments result in an entry added to the document's Open Questions section
- Works on all editable artifact types: PRD, Implementation Plan, Template
- New artifact version created before agent applies changes (enables revert)
- Loading/progress indicator while agent is working

### Out (Deferred)

- Agent asking clarifying questions back in the comment thread (adds complexity; open questions section is sufficient for MVP)
- Diff preview before applying changes (users can revert via version history)
- Reviewer-initiated resolution (author-only for MVP)
- Comment-level undo (version-level revert is sufficient)
- Agent explaining its changes in the comment thread
- Partial/selective accept of agent-proposed changes within a single comment

### Success Metrics

| Metric | Baseline | Target | How Measured |
|--------|----------|--------|--------------|
| Adoption rate (% of authors using agent resolution) | 0% | 60% of active authors within 30 days | FE event tracking |
| Time to resolve all comments on a document | Manual baseline TBD | 50% reduction | Time between first comment selection and last thread resolved |
| Comments resolved via agent vs. manually | 0% agent | 40% agent-resolved | BE event tracking |
| Revert rate (agent changes reverted) | N/A | < 10% | BE version history |

### Kill Criteria

If adoption doesn't reach 30% of active document authors within 60 days, or revert rate exceeds 25%, deprioritize and investigate user feedback.

---

## Risks

### Dependencies & Risks

| Risk/Dependency | Mitigation | Owner |
|-----------------|------------|-------|
| Liveblocks API rate limits on batch thread resolution | Sequential processing; client-side resolution after each thread | Eng |
| Agent misinterprets comment and makes incorrect edit | Version created before changes; easy revert. Revert rate monitored as kill metric | Product/Eng |
| Agent modifies unrelated sections of document | Scope agent edits to anchored text region + Open Questions section | Eng |
| Liveblocks thread resolution API availability | Thread resolution handled client-side via existing Liveblocks SDK; no server-side resolution needed | Eng |
| Large documents may cause slow agent response | Set timeout; show progress indicator; consider chunking | Eng |

---

## Resolved Questions

- **Q-001:** Thread resolution happens client-side via the app UI after the agent completes edits. No server-side Liveblocks resolution needed.
- **Q-002:** Agent processes comments sequentially, one thread at a time. Simpler, avoids conflicting edits, and keeps progress reporting straightforward.
- **Q-003:** Uses the Loops infrastructure for agent execution. This provides managed agent runs with streaming, progress tracking, and error handling.
- **Q-004:** No maximum. Users can resolve all comments in a single batch regardless of count.
- **Q-005:** If a comment references external content (e.g., "see the Figma", "per our Slack discussion"), the agent should attempt to resolve it only if it has a reference and access to that external content. Otherwise, the agent adds an open question to the document citing the external reference and resolves the thread.

## Open Questions

*None at this time.*

---

## User Stories

### US-001: Resolve selected comments with agent

**As a** document author, **I want** to select one or more unresolved comment threads and have an AI agent incorporate the feedback into my document **so that** I don't have to manually edit the document for each comment.

**Priority:** P0 | **Notes:** Core feature. Agent reads comment text + anchored context, edits document, resolves threads.

---

### US-002: Resolve all comments with agent

**As a** document author, **I want** a "Resolve All" option that processes every unresolved comment thread on the document **so that** I can address all feedback in one action.

**Priority:** P0 | **Notes:** Convenience shortcut over US-001. Same agent behavior, applied to all open threads.

---

### US-003: Open questions for ambiguous comments

**As a** document author, **I want** the agent to add an open question to the document's Open Questions section when a comment is unclear or ambiguous **so that** I can follow up with the reviewer rather than having bad edits applied.

**Priority:** P0 | **Notes:** Agent should still resolve the thread but note the ambiguity. Open question format: Q-### with reference to the original comment.

---

### US-004: Version snapshot before agent changes

**As a** document author, **I want** a new artifact version created automatically before the agent applies changes **so that** I can easily revert if the agent's edits aren't what I wanted.

**Priority:** P0 | **Notes:** Leverages existing artifact versioning. No new UI needed — user reverts via existing version history.

---

### US-005: Progress feedback during resolution

**As a** document author, **I want** to see a loading/progress indicator while the agent is resolving comments **so that** I know the system is working and approximately how long it will take.

**Priority:** P1 | **Notes:** Could show per-thread progress for batch operations (e.g., "Resolving 3 of 7 comments...").

---

### US-006: Error handling for failed resolutions

**As a** document author, **I want** to be notified if the agent fails to resolve a comment **so that** I know which comments still need manual attention.

**Priority:** P1 | **Notes:** Failed threads should remain unresolved. Toast or inline notification with the thread reference.

---

## Technical Notes

- **Agent infrastructure:** Uses the Loops infrastructure for agent execution. This provides managed agent runs with streaming, progress tracking, and error handling out of the box.
- **Processing model:** Comments are processed sequentially, one thread at a time. This avoids conflicting edits to the same document region and simplifies progress reporting.
- **Thread resolution:** Handled client-side via the Liveblocks SDK after the agent completes edits for each thread. No server-side Liveblocks integration required.
- **Editor integration:** The Tiptap editor with Liveblocks collaboration is already in place. The agent needs to produce edits compatible with the Tiptap/Liveblocks document model (likely markdown content updates via the artifact version API).
- **Liveblocks threads:** Comments are Liveblocks threads anchored to document text. The Liveblocks SDK provides thread metadata including the anchored text range and comment body.
- **External references:** When comments reference external content, the agent resolves only if it has access to that content. Otherwise, it adds an open question citing the reference.
- **Artifact versioning:** `ArtifactVersion` model already supports immutable version history. Creating a snapshot before agent edits is straightforward.

---

*Stories expanded during refinement. Implementation details determined by engineering.*
