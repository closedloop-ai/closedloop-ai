# Document Pull Request Route Consolidation Plan

## Context

PR 1011 introduced a new plural endpoint:

- `GET /documents/[id]/pull-requests`

The existing singular endpoint remains:

- `GET /documents/[id]/pull-request`

Both routes perform the same auth, document ID resolution, service delegation, and response wrapping. The main difference is the response shape:

- Singular route: `PullRequestInfo | null`
- Plural route: `PullRequestInfo[]`

Investigation across `symphony-alpha` and `closedloop-electron` found no current Electron usage of either document PR endpoint. In `symphony-alpha`, the only active UI consumer has moved to the plural multi-PR hook, while the singular hook is exported but not used by app code.

The remaining singular behavior is useful internally as a service-level helper for "primary PR" resolution, especially evaluate-code branch selection, but that does not require preserving the singular HTTP route contract.

## Recommendation

Do not add or keep the new plural HTTP route. Instead, evolve the existing internal route:

- Keep path: `GET /documents/[id]/pull-request`
- Change response type to: `PullRequestInfo[]`
- Delegate to: `documentWorkstreamService.getDocumentPullRequests(...)`

This keeps one canonical document-PR endpoint and removes duplicated route-level code.

## Goals

- Reduce PR surface area and duplicate route boilerplate.
- Make the API match the product model that one plan can produce multiple PRs.
- Keep service-level helpers for primary-PR behavior where the business logic still needs it.
- Avoid maintaining both singular and plural HTTP routes when no known external consumer needs the old singular response shape.

## Non-Goals

- Do not remove `documentWorkstreamService.getDocumentPullRequest(...)` if evaluate-code still depends on primary-PR semantics.
- Do not change unrelated pull request APIs such as `/pull-requests/[id]/rating`.
- Do not change Electron contracts unless a later search finds a real dependency.

## Implementation Steps

1. Remove the plural route file:

   - `apps/api/app/documents/[id]/pull-requests/route.ts`

2. Update the existing singular route:

   - File: `apps/api/app/documents/[id]/pull-request/route.ts`
   - Change generic response type from `PullRequestInfo | null` to `PullRequestInfo[]`.
   - Replace `getDocumentPullRequest(...)` with `getDocumentPullRequests(...)`.
   - Update error copy from `Failed to fetch PR` to `Failed to fetch PRs`.

3. Consolidate frontend query hooks:

   - File: `apps/app/hooks/queries/use-documents.ts`
   - Remove `useDocumentPullRequests`.
   - Change `useDocumentPullRequest` to return `PullRequestInfo[]`.
   - Keep the existing query key/path if minimizing churn:
     - query key suffix: `"pull-request"`
     - path: `/documents/${documentId}/pull-request`
   - Optionally rename the hook later in a separate cleanup if desired.

4. Update plan UI call sites:

   - File: `apps/app/app/(authenticated)/implementation-plans/[slug]/plan-editor.tsx`
   - Import the consolidated hook.
   - Keep the current multi-PR UI behavior:
     - `const { data: pullRequests = [] } = useDocumentPullRequest(plan.id);`
     - Resolve `primaryPr` from `repoFullName === plan.targetRepo`, then fallback to the first PR.

5. Update tests:

   - File: `apps/api/__tests__/unit/document-pull-requests-routes.test.ts`
   - Remove plural-route import and plural-route test block.
   - Update singular route tests to assert array responses:
     - no PRs returns `{ data: [] }`
     - one or more PRs returns `{ data: [pr] }`
   - Ensure service mock uses `getDocumentPullRequests`.

6. Remove now-unused imports and route references:

   - Search for `useDocumentPullRequests`.
   - Search for `/documents/${documentId}/pull-requests`.
   - Search for `documents/[id]/pull-requests`.

## Testing Plan

Run focused checks first:

```bash
pnpm -C apps/api test apps/api/__tests__/unit/document-pull-requests-routes.test.ts
pnpm -C apps/app test -- --runInBand
```

If package-local test command syntax differs, use the repo's standard focused Vitest command for the affected workspace.

After implementation is complete, run the standard repo verification commands through `just`:

```bash
just test
just typecheck
just lint
```

## Risks

- Stale deployed web clients could still expect `PullRequestInfo | null` from `/documents/[id]/pull-request`.
- This risk appears acceptable for this scope because current-source consumers are internal, Electron does not call the endpoint, and the PR already transitions the active UI to multi-PR behavior.
- The route name will remain singular while returning an array. This is semantically imperfect, but it avoids adding a parallel endpoint and keeps the PR smaller.

## Follow-Up Cleanup

If route naming consistency becomes more important than churn minimization, a later PR can rename the endpoint to `/documents/[id]/pull-requests` and remove `/pull-request` entirely after confirming there are no stale-client concerns.
