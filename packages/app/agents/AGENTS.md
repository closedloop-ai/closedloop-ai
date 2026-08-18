# @repo/app/agents — Sessions surfaces

Renders the Sessions list, summary, and detail for **both** shells (`apps/app` web, `apps/desktop` renderer).

**Scope note:** cross-feature rules live in `packages/app/AGENTS.md` — don't add one here, siblings won't see it.

## Session fixtures

Props for isolated stories and tests come from `session-list-fixtures.ts` and `agent-component-fixtures.ts` rather than hand-built literals, so a shape change lands in one place.

**Placement is the recurring miss.** A story beside `agents/lib/*` is never picked up — `agents/components/` is the only scanned location in this feature.

## Session identity

Session detail is reachable from several entry points and by same-component navigation. Scope draft comments, anchors, highlights, and expansion to the stable `session.id`, and reset or key on identity change so one session's local state cannot carry into the next.
