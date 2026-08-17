import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "sign-in",
  title: "Web Sign In",
  summary:
    "The signed-out auth path end to end. Kaiti's sign-in hierarchy (GitHub as the single primary action, Google de-emphasized to match the email field, Continue demoted to secondary), plus the desktop connect sequence it hands off to: one waiting treatment across every waiting stop INCLUDING the failure branches, and the device consent brought into the same family instead of a Card at max-w-xl. Two calls it makes explicitly — the consent route stays under (authenticated) inside the sidebar shell, so 'same family' means heading scale and column width rather than the whole page; and the 400ms reveal hold every waiting panel ships with is deliberately not simulated here, because a reference that renders empty on each stop switch is a worse review tool. Not yet settled: the consent screen is still its own spelling in production, so the count went from three to two, not one.",
  author: "Kaiti",
  status: PrototypeStatus.HandedOff,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-14",
  linearIssue: null,
  closedloopDoc: "PLN-1526",
} satisfies PrototypeMeta;
