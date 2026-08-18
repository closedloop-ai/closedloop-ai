import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "session-subagent-transcripts",
  title: "Session subagent transcript disclosure",
  summary:
    "The transcript file switcher at the top of the Session Trace, collapsed by default. A session with nine subagent sidechains currently renders nine pills wrapped over three rows above the trace; this folds them behind one disclosure row while keeping Main, and the file you are actually reading, pinned inline, because collapsing may hide options but never where you are. The pinned file is also listed inside the drawer so the header count and the revealed chips always agree. The header count is a count of transcript FILES and says so: when the session's Subagents metric reports more subagents than there are readable files, it reconciles out loud ('12 subagents, 9 transcripts available') instead of quietly contradicting the metric, and it states the number once rather than twice. Still-uploading and permanently-skipped sidechains are worded differently ('still uploading' vs 'unavailable') because 'yet' is a promise the product cannot keep for a skipped file, the caveat is toned as a warning rather than rendered in the calmest color we own, and a permanently-unavailable chip is a plain status chip rather than a live link to an error state. Unavailable is kept distinct from zero: with no reported per-file availability the switcher makes no claim at all rather than rendering a confident empty state. Sandbox note: the 'Sandbox controls' chip row is reviewer chrome to flip the mock cohort, not part of the surface; the greyed rows below the switcher stand in for the Session Trace. ISS-4625 built this same idea on SessionOverviewSection, which has no production consumer, so this prototype targets the surface users actually see.",
  author: "Mike",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-08-02",
  linearIssue: null,
  closedloopDoc: "ISS-4677",
} satisfies PrototypeMeta;
