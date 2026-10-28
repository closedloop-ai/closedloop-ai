// gardener-support: test and story data, not shipped
import { DISPLAYED_SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { RelatedSessionTableItem } from "./related-sessions-table-cell";

export const RELATED_SESSIONS_FIXTURE_NOW = new Date(
  "2026-08-21T15:00:00.000Z"
);

const EXAMPLE_AVATAR_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' rx='20' fill='%23c7d2fe'/%3E%3Cpath d='M7 40c1-9 6-14 13-14s12 5 13 14' fill='%234f46e5'/%3E%3Cellipse cx='20' cy='18' rx='9' ry='10' fill='%23f3c6a8'/%3E%3Cpath d='M11 17C11 8 16 5 21 5c7 0 10 6 9 13-4-2-7-5-9-9-2 4-6 7-10 8Z' fill='%23312e81'/%3E%3Ccircle cx='17' cy='18' r='1' fill='%23312e81'/%3E%3Ccircle cx='23' cy='18' r='1' fill='%23312e81'/%3E%3Cpath d='M17 22c2 2 4 2 6 0' fill='none' stroke='%239c4f4f' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E";

export const RELATED_SESSIONS_FIXTURE_ITEMS: readonly RelatedSessionTableItem[] =
  [
    {
      href: "/artifacts/PRD-595?tab=sessions&traceRow=102",
      id: "session-newest",
      occurredAt: "2026-08-21T09:04:00.000Z",
      ownerAvatarUrl: EXAMPLE_AVATAR_URL,
      ownerName: "Avery Example",
      relationshipLabel: "Wrote to artifact",
      sessionSlug: "SES-595-3",
      status: DISPLAYED_SESSION_STATUS.ACTIVE,
    },
    {
      href: "/artifacts/PRD-595?tab=sessions&traceRow=86",
      id: "session-middle",
      occurredAt: "2026-08-14T18:30:00.000Z",
      ownerName: "Morgan Sample",
      relationshipLabel: "Commented on artifact",
      sessionSlug: "SES-595-2",
      status: DISPLAYED_SESSION_STATUS.INACTIVE,
    },
    {
      id: "session-oldest",
      occurredAt: "2026-08-02T11:00:00.000Z",
      ownerName: "Riley Demo",
      relationshipLabel: "Wrote to artifact",
      sessionSlug: "SES-595-1",
      status: DISPLAYED_SESSION_STATUS.ERROR,
    },
  ];
