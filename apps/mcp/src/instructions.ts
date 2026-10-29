import { WEBAPP_URL } from "./tools/tool-utils.js";

/**
 * What a reader must be told about an org-less `webUrl` (ISS-6570).
 *
 * Declared ABOVE `SERVER_INSTRUCTIONS` rather than at the bottom of the file
 * because the template literal below reads it at module evaluation.
 *
 * It is a constant, and not just a sentence inlined into the instructions,
 * because the published MCP reference must state the same thing. Since ISS-10525
 * deleted the parity guard that held every reference page to this exact text,
 * editing it here means editing the pages in the same change; the pages are what
 * an integrator actually reads, and for a while they promised an org segment this
 * server had already made conditional (ISS-6769).
 */
export const ORG_LESS_WEB_URL_CAVEAT =
  "The org slug is omitted when the server cannot confirm it for the current session, leaving an org-less path such as `/documents/ISS-1035`. The browser resolves that URL against whichever org the reader is signed into — it is a redirect, not a tenant-bound link — so do not describe it as pointing at a specific organization, never read an org segment out of a `webUrl` as a tenant identifier, and never add a slug back to fix one.";

export const SERVER_INSTRUCTIONS = `\
Closedloop is a human-governed, AI-centric software delivery platform. You are connected to the Closedloop MCP server, which gives you visibility into the organization's projects, documents, and work tracking.

## Entity Hierarchy

Project (PRO-*) -> Document (PRD-*, PLN-*, ISS-*)

- **Projects** are weekly or thematic containers (e.g. "5/11-15", "Enterprise").
- **Documents** are the deliverables: PRDs (PRD-*), Implementation Plans (PLN-*), and Issues (ISS-*; legacy \`FEA-*\` slugs still resolve to the same Issue).
- **Tags** are free-form labels that group DOCUMENTS across projects (e.g. "DSP", "agent-fleet"). They are the way to group work thematically WITHOUT changing where it lives. Read them with \`list-tags\`; apply and remove them with \`tag-artifact\` and \`untag-artifact\`, which target documents only -- a \`PRO-*\` project is not a valid target for either, even though the product itself can tag a project.

## Work Tracking

When you begin work on a Closedloop document (any ISS-* / FEA-*, PLN-*, or PRD-* referenced in the user's request):

- **Update the document status** to reflect that work has started via \`update-document\`. Issues move to IN_PROGRESS; Documents (PRD/Plan) have no IN_PROGRESS — leave them DRAFT until ready, then IN_REVIEW. Pick the status from the lifecycle that matches the artifact type (see "Status Lifecycle" below).
- **Update the document status** when work lands via \`update-document\`. Issues: IN_REVIEW (PR open) → DONE (merged). Documents: IN_REVIEW → APPROVED (signed off).

## Status Lifecycle

Documents and Issues have **separate** status vocabularies — use the one that matches the artifact type. The same \`status\` value is rejected if it doesn't belong to the artifact's vocabulary.

**Documents** (PRD-*, PLN-*; authoring / approval lifecycle):
- DRAFT -> IN_REVIEW -> APPROVED (sign-off; terminal).
- CHANGES_REQUESTED when a review asks for rework (return to IN_REVIEW after).
- EXECUTED for Implementation Plans that have been executed.
- OBSOLETE for deprecated or replaced documents.

**Issues** (ISS-*; legacy \`FEA-*\` slugs are the same Issue; delivery lifecycle):
- TRIAGE (incoming, agent-created, awaiting human assessment) -> BACKLOG (captured, unscheduled) -> TODO (scheduled) -> IN_PROGRESS -> IN_REVIEW (PR open) -> DONE (merged / shipped).
- BLOCKED when stuck on a dependency, question, or failure.
- CANCELED for won't-do.

Update status as work progresses, using the vocabulary that matches the artifact's type.

## Web URLs

When referencing Closedloop entities to the user, use the \`webUrl\` field returned by tool responses (e.g. \`get-document\`). URLs usually include an org-specific slug in the path:

| Entity | URL Pattern |
|--------|-------------|
| Issue | \`${WEBAPP_URL}/<org-slug>/documents/{slug}\` (e.g. \`/acme/documents/ISS-1035\`; legacy \`FEA-\` slugs and \`/features/\`, \`/issues/\`, \`/prds/\`, \`/implementation-plans/\` links still resolve) |
| PRD | \`${WEBAPP_URL}/<org-slug>/documents/{slug}\` (e.g. \`/acme/documents/PRD-42\`) |
| Implementation Plan | \`${WEBAPP_URL}/<org-slug>/documents/{slug}\` (e.g. \`/acme/documents/PLN-7\`) |

Do NOT construct URLs manually. Always use the \`webUrl\` field from tool responses.

${ORG_LESS_WEB_URL_CAVEAT}

Always prefer slugs over UUIDs in user-facing output. When listing documents, show the slug (ISS-1035) not the UUID.

## Slug Conventions

- Projects: PRO-* (e.g. PRO-25)
- PRDs: PRD-* (e.g. PRD-42)
- Implementation Plans: PLN-* (e.g. PLN-7)
- Issues: ISS-* (e.g. ISS-1035); legacy \`FEA-*\` slugs (e.g. FEA-1035) still resolve to the same Issue
- Users: UUID only (no slug), but \`get-me\` returns the current user's profile

Document and project tools accept both UUIDs and slugs -- pass the user's slug verbatim. User tools require UUIDs only.

## Best Practices

- When the user references a document by slug (e.g. "implement ISS-1035" or a legacy "implement FEA-1035"), fetch it with \`get-document\` to understand the full context before starting work.
- Use \`list-documents\` with \`assigneeId\` to find work assigned to a specific user.
- Use \`search\` for free-text lookups across projects and documents when you don't already have a slug or filter (e.g. "find the auth PRD").
- When creating a PRD, implementation plan, or issue, always attach it to a project via \`projectId\`. An organization-level document (\`type: DOC\`) needs no \`projectId\`.
- When creating a project, always pass \`teamId\`. A project with no team has no URL in the web app, so a human cannot open it or see the documents inside it. If you do not know a team id, call \`list-teams\`, or call \`create-project\` without one and the 400 will list this organization's teams; retry with one of them.
- To group work under a theme (a customer, a platform, an initiative), apply a tag with \`tag-artifact\` -- do NOT create a project for it. Projects are containers for where work lives; tags are the cross-cutting labels. An unknown tag name is created for you, so "tag this ISS-1035 DSP" is a single call.`;
