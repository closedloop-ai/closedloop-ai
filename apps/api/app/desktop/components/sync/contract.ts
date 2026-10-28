/**
 * ISS-8618 (PRD-699 §7.5): success body of `POST /desktop/components/sync`.
 *
 * Backend-only. Both consumers are in `apps/api` — this route and its service —
 * so the root AGENTS.md homes it here rather than in `packages/api/src/types/`,
 * which is for types used by BOTH apps. Co-located rather than declared in
 * `route.ts` because the service returns it and `apps/api/AGENTS.md` keeps type
 * definitions out of route files. Shape unchanged.
 */
export type DesktopComponentsSyncResponse = { synced: boolean };
