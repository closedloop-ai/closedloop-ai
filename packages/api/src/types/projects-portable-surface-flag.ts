/**
 * ISS-10476 (ISS-4779 closed-by-default policy): gates the team Projects route
 * mounting the PORTABLE Projects surface — `ProjectList` from `@repo/app`, the
 * list/board surface the Web Master prototype renders — instead of the
 * `DocumentRow`-based `ProjectsTable` that ships today.
 *
 * ONE key, because the surface lives in `@repo/app` and any shell that grows a
 * Projects screen mounts the same component: the desktop renderer resolves the
 * signed-in account's PostHog assignment from this same key space, so there is
 * no second desktop key and no Labs toggle beside it.
 *
 * What the gate selects is WHICH COMPONENT the route mounts, not which projects
 * exist: both branches read the same `useProjectsByTeam` query, and the portable
 * branch is a render of those rows.
 *
 * Dependency-free so every consumer imports the SAME literal rather than
 * redeclaring it.
 */
export const PROJECTS_PORTABLE_SURFACE_FLAG_KEY =
  "projects-portable-surface" as const;
