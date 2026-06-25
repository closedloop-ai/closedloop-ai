import { WEBAPP_URL } from "./tools/tool-utils.js";

export const SERVER_INSTRUCTIONS = `\
Closedloop is a human-governed, AI-centric software delivery platform. You are connected to the Closedloop MCP server, which gives you visibility into the organization's projects, documents, and work tracking.

## Entity Hierarchy

Project (PRO-*) -> Document (PRD-*, PLN-*, FEA-*)

- **Projects** are weekly or thematic containers (e.g. "5/11-15", "Enterprise").
- **Documents** are the deliverables: PRDs (PRD-*), Implementation Plans (PLN-*), and Features (FEA-*).
- **Loops** are automation runs that track work execution -- both platform-managed and manual.

## Work Tracking with Manual Loops

When you begin work on a Closedloop document (any FEA-*, PLN-*, or PRD-* referenced in the user's request):

1. **Update the document status** to IN_PROGRESS via \`update-document\`.
2. **Create a manual loop** linked to the document via \`create-loop\`. Include the repo name and branch if applicable.
3. **Post progress events** via \`add-loop-event\` at meaningful milestones:
   - After initial investigation / codebase reading
   - After core implementation is complete
   - After tests pass
   - After code review / simplification
   - Before PR creation
   - When blocked or changing approach
4. **Complete the loop** via \`complete-loop\` with summary, PR URL, and branch name when done.
5. **Update the document status** to IN_REVIEW (PR created) or DONE (merged) via \`update-document\`.

If the work fails or is abandoned, use \`fail-loop\` or \`cancel-loop\` with a clear explanation.

Do NOT create a manual loop if \`$CLOSEDLOOP_LOOP_ID\` is set -- that means you're already inside a platform-managed loop.

## Status Lifecycle

Documents follow this progression:
- DRAFT -> IN_PROGRESS -> IN_REVIEW -> APPROVED -> EXECUTED -> DONE
- Use OBSOLETE for deprecated documents.

Update status as work progresses. Don't leave documents in DRAFT after starting work.

## Web URLs

When referencing Closedloop entities to the user, use the \`webUrl\` field returned by tool responses (e.g. \`get-document\`, \`create-loop\`). URLs include an org-specific slug in the path:

| Entity | URL Pattern |
|--------|-------------|
| Feature | \`${WEBAPP_URL}/<org-slug>/features/{slug}\` (e.g. \`/acme/features/FEA-1035\`) |
| PRD | \`${WEBAPP_URL}/<org-slug>/prds/{slug}\` (e.g. \`/acme/prds/PRD-42\`) |
| Implementation Plan | \`${WEBAPP_URL}/<org-slug>/implementation-plans/{slug}\` (e.g. \`/acme/implementation-plans/PLN-7\`) |
| Loop | \`${WEBAPP_URL}/<org-slug>/loops/{id}\` (UUID only) |

Do NOT construct URLs manually. Always use the \`webUrl\` field from tool responses -- it contains the correct org slug for the current session.

Always prefer slugs over UUIDs in user-facing output. When listing documents, show the slug (FEA-1035) not the UUID.

## Slug Conventions

- Projects: PRO-* (e.g. PRO-25)
- PRDs: PRD-* (e.g. PRD-42)
- Implementation Plans: PLN-* (e.g. PLN-7)
- Features: FEA-* (e.g. FEA-1035)
- Loops: UUID only (no slug)
- Users: UUID only (no slug), but \`get-me\` returns the current user's profile

Document and project tools accept both UUIDs and slugs -- pass the user's slug verbatim. Loop and user tools require UUIDs only.

## Best Practices

- When the user references a document by slug (e.g. "implement FEA-1035"), fetch it with \`get-document\` to understand the full context before starting work.
- Use \`list-documents\` with \`assigneeId\` to find work assigned to a specific user.
- After creating a PR for a feature, use \`complete-loop\` to link the PR URL so it appears in the Closedloop dashboard.
- When creating documents, always attach them to a project via \`projectId\`.`;
