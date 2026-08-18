import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "multisession-trace",
  title: "Multi-session trace (collapsed)",
  summary:
    "FEA-4182: redesign of the Branch/Session multi-session trace using Claude Code / Codex as the interaction reference. This collapsed session list is the replacement for the branches prototype's flat CombinedTrace inside the branch detail's Sessions & timeline tab — it IS the trace for that tab, not a new Branch page and not a second view beside CombinedTrace; the standalone page here only isolates the component for review. When a Branch or Session aggregates multiple associated sessions (implementation, code review, follow-up), each associated session renders as ONE scannable collapsed box (role/kind label, plus a compact actor · duration · cost meta line) that expands on demand to reveal that session's own transcript, whose sub-agent work stays collapsed. CI is a workflow of checks, not a conversational session, so it rides in a compact checks strip on the branch header rather than the session list. No sprawling nested timeline of pills.",
  author: "Metal Parker",
  status: PrototypeStatus.Draft,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-26",
  linearIssue: null,
  closedloopDoc: null,
} satisfies PrototypeMeta;
