// The classification tables behind the four-level taxonomy (see TAXONOMY.md).
// Consumed by sync-component-catalog.mjs, which generates the catalog and
// computes every colocated story's expected `title:`. Also consumed, once,
// by the one-time PLN-2024 Phase C script that rewrote every story's
// existing `title:` to match — reviewed and deleted after that migration
// landed. Kept separate from the generator so the rules are reviewable on
// their own rather than buried in its plumbing.

// --- Design system (packages/design-system/components/ui/**) -------------
//
// Level: everything here defaults to Primitive unless it appears in
// DS_COMPOSITE_DOMAIN (feature-bound) below, or has any
// @repo|@closedloop-ai design-system import of another ui/ component other
// than itself (computed at sync time, not listed here) — that import makes
// it a Composite, grouped by DS_ELEMENT_KIND same as a Primitive would be,
// unless it is one of the feature-bound ones.
//
// A handful of feature-bound composites get a domain instead of an element
// kind — everything to do with comments/conversation threads.
export const DS_COMPOSITE_DOMAIN = {
  "comment-thread": "Documents",
  "comment-composer": "Documents",
  "comment-action-menu": "Documents",
  "comment-thread-action-footer": "Documents",
  "feed-rail": "Documents",
  "inline-edit-editor-shell": "Documents",
};

// Element kind for every other design-system id, Primitive or Composite.
// `pagination` is deliberately absent — it is the private surface composed
// by table-pagination, excluded from the catalog entirely.
const DS_OVERLAYS_CORE = new Set([
  "dialog",
  "drawer",
  "sheet",
  "popover",
  "tooltip",
  "dropdown-menu",
  "alert-dialog",
  "info-hint",
  "grid-table-v2-tooltip",
]);
const DS_INPUTS_VIA_OVERLAY = new Set([
  "date-picker-popover",
  "filter-popover",
  "filter-popover-v2",
  "user-select-popover",
  "command",
]);
const DS_CHARTS = new Set([
  "chart",
  "category-bar-chart",
  "donut-chart",
  "donut-slice-textures",
  "time-series-area-chart",
  "sparkline",
  "segmented-bar",
  "ranked-bar",
  "graph",
  "activity-heatmap",
  "analytics-range-toggle",
]);
const DS_ACTIONS = new Set(["button", "copy-button", "favorite-button"]);
const DS_INPUTS = new Set([
  "input",
  "textarea",
  "checkbox",
  "checkbox-tree",
  "radio-group",
  "switch",
  "select",
  "calendar",
  "form",
  "label",
  "filter-chip",
  "filter-range-submenu",
  "filter-range-submenu-v2",
  "active-filters-bar",
  "active-filters-bar-v2",
  "toggle",
  "toggle-group",
]);
const DS_FEEDBACK = new Set([
  "priority-badge",
  "priority-icon",
  "status-icon",
  "status-icon-primitives",
  "status-percentage-icon",
  "status-badge",
  "tone-label",
  "inline-edit-feedback",
  "alert",
  "empty",
  "empty-state",
  "skeleton",
  "progress",
  "sonner",
  "status-metadata-section",
]);
const DS_LAYOUT = new Set([
  "card",
  "collapsible",
  "collapsible-section",
  "resizable",
  "scroll-area",
  "section",
  "kanban-board",
  "separator",
]);
const DS_NAVIGATION = new Set([
  "breadcrumb",
  "mode-toggle",
  "theme-submenu",
  "tabs",
  "underline-tabs",
  "navigation-menu",
  "sidebar",
  "sidebar-collapsible-section",
  "sidebar-count-badge",
]);
const DS_CONTENT = new Set([
  "code-block",
  "markdown-content",
  "unified-diff",
  "brand-icons",
]);
const DS_DATA_DISPLAY = new Set([
  "avatar",
  "drag-preview-chip",
  "person-avatar",
  "badge",
  "chip",
  "count-cell",
  "mono-id-cell",
  "inline-date-cell",
  "inline-name-cell",
  "inline-reference-cell",
  "inline-scalar-cell",
  "inline-select-cell",
  "inline-tag-cell",
  "metadata-panel",
  "metric-card",
  "metric-card-lane",
  "data-table",
  "group-section-header",
  "grid-interaction-contract",
  "grid-row-drag-handle",
  "sortable-subtree",
  "move-between-sections-icon",
  "section-header",
  "sortable-column-header",
]);

// "A single dependency does not make you a composite" (TAXONOMY.md). These
// import one or two other design-system components but still render as ONE
// element — CE's own worked examples (Copy Button imports Button, Alert
// Dialog imports Button, Calendar imports Button) extended to this repo's
// equivalents. Anything NOT listed here falls through to the default rule
// (any design-system import at all -> Composite), which is correct for
// genuine multi-part things like Kanban Board (imports one component, renders
// a board) or the filter/menu family (3+ imports, composed from parts).
export const DS_SINGLE_ELEMENT_OVERRIDE = new Set([
  "alert-dialog",
  "calendar",
  // One `tree` widget: it composes Checkbox for the glyph and reuses the
  // table tree lead's indent rule, but renders a single ARIA tree (ISS-12517).
  "checkbox-tree",
  "command",
  "copy-button",
  "empty-state",
  "favorite-button",
  "filter-chip",
  "form",
  "grid-table-v2-tooltip",
  "grid-row-drag-handle",
  "info-hint",
  "person-avatar",
  "ranked-bar",
  "section",
  "sortable-column-header",
  "status-badge",
  "table-pagination",
  "toggle-group",
  "underline-tabs",
]);

export function designSystemGroup(id) {
  if (DS_COMPOSITE_DOMAIN[id]) {
    return { kind: "domain", group: DS_COMPOSITE_DOMAIN[id] };
  }
  if (DS_INPUTS_VIA_OVERLAY.has(id)) {
    return { kind: "element", group: "Inputs" };
  }
  if (DS_OVERLAYS_CORE.has(id)) {
    return { kind: "element", group: "Overlays" };
  }
  // Segment match, not substring: `id.includes("table")` also caught
  // `sortable-column-header`, which made its explicit DS_DATA_DISPLAY entry
  // unreachable and would have silently swept up the next `editable-`,
  // `portable-` or `notable-` id with nothing saying why (PR #7280 review).
  if (id.split("-").includes("table")) {
    return { kind: "element", group: "Data Display/Tables" };
  }
  if (DS_CHARTS.has(id)) {
    return { kind: "element", group: "Charts" };
  }
  if (DS_ACTIONS.has(id)) {
    return { kind: "element", group: "Actions" };
  }
  if (DS_INPUTS.has(id)) {
    return { kind: "element", group: "Inputs" };
  }
  if (DS_FEEDBACK.has(id)) {
    return { kind: "element", group: "Feedback & Status" };
  }
  if (DS_LAYOUT.has(id)) {
    return { kind: "element", group: "Layout" };
  }
  if (DS_NAVIGATION.has(id)) {
    return { kind: "element", group: "Navigation" };
  }
  if (DS_CONTENT.has(id)) {
    return { kind: "element", group: "Content" };
  }
  if (DS_DATA_DISPLAY.has(id)) {
    return { kind: "element", group: "Data Display" };
  }
  return null;
}

// --- App Core (packages/app/<feature>/components/**, colocated stories) --
//
// Level: a zero-design-system-import component is a Primitive UNLESS it is
// over 150 lines or its id matches APP_CORE_RECLASSIFY_PATTERN — either one
// means the import graph is undercounting a component that builds everything
// inline instead of reusing parts (see TAXONOMY.md, "The import graph
// measures reuse, not complexity"). Anything with a design-system import, or
// caught by that reclassification, is a Composite in its feature's domain.
// `comments-rail`: a host's rail is a thin wrapper over the shared comments
// shell (ISS-11209), so its own import graph reads as zero reuse.
export const APP_CORE_RECLASSIFY_PATTERN =
  /panel|surface|summary-cards|trace|timeline|breakdown|waterfall|properties$|comments-rail|design-preview/;
export const APP_CORE_RECLASSIFY_LINES = 150;

// Element kind overrides for the App Core ids that stay Primitives despite
// living inside a feature package (location never decides level — see
// TAXONOMY.md "Where the code lives does not matter").
export const APP_CORE_PRIMITIVE_ELEMENT_KIND = {
  "agent-pipeline-graph": "Charts",
  "session-branches-row": "Data Display",
  "session-comments-rail": "Data Display",
  "session-loc-per-dollar-property": "Data Display",
  "session-output-diff": "Content",
  "session-pull-requests-row": "Data Display",
  "session-group-icons": "Data Display",
  "session-provenance-chip": "Feedback & Status",
  "branch-cell-primitives": "Data Display/Tables",
  "branch-provider-availability": "Feedback & Status",
  // "favorite-button" is deliberately absent: it wires the design-system
  // FavoriteButton to Documents-specific hooks (useIsFavoriteArtifact /
  // useToggleFavoriteArtifact), so it falls through to the default rule and
  // lands as Composites/Documents — both correct (it IS feature-bound) and
  // necessary (a generic "Actions" primitive here would collide with the
  // design-system's own unrelated favorite-button, which shares the id).
  "static-cells": "Data Display/Tables",
  "tags-cell": "Data Display/Tables",
  "session-status-icon": "Feedback & Status",
  "overview-metric": "Data Display",
  "session-limits-detail": "Data Display",
  "artifact-status": "Feedback & Status",
  "feature-flag-pending": "Feedback & Status",
  "metric-card-snapshot-notice": "Feedback & Status",
  "tag-color-picker": "Inputs",
};

// Domain per packages/app/<feature> directory. `shared` and `shell` merge
// into one domain (see TAXONOMY.md). Directories not listed here (no
// stories yet) still resolve through DOMAIN_TITLE_OVERRIDES / the
// title-casing fallback if a story is ever added.
export const FEATURE_TO_DOMAIN = {
  shared: "App Shell",
  shell: "App Shell",
};

export const DOMAIN_TITLE_OVERRIDES = {
  "api-keys": "API Keys",
  "custom-fields": "Custom Fields",
  github: "GitHub",
  google: "Google",
  "judges-analytics": "Judges & Analytics",
  "my-tasks": "My Tasks",
  "session-limits": "Session Limits",
};

// Per-component domain overrides, keyed by story id, checked before any
// directory-based rule. The directory is a hint, not the rule:
// `cost-metric-card` is consumed by the Insights overview
// dashboard despite living under agents/components/sessions/, and
// `active-runs-panel` is an agent-runtime dashboard card, not part of the
// Sessions list, despite the same location. `tag-chip` remains a Tags concept
// after its reusable presentation moves under shared ownership.
export const DOMAIN_OVERRIDE_BY_ID = {
  "cost-metric-card": ["Insights"],
  "active-runs-panel": ["Agents", "General"],
  "tag-chip": ["Tags"],
};

// Where each v2.0 Composite and Pattern sits (Nerys, 2026-10-06; rules in
// TAXONOMY.md, "The page tree"). The v1.0 domain rules above do not
// apply to them: v2.0 is grouped like Surfaces, by the page that uses a
// part, not by element kind or feature domain.
//
// - A Composite is a section of a page. `path` is the Surfaces path of
//   the page that uses it (the deepest node every using page shares), and
//   its title is "Composites/<path>/<Label>". A section used by pages in
//   more than one part of the tree goes under Shared, in a group named for
//   the kind of page it is a section of.
// - A Pattern is a page's shell or layout, with no content in it. Its title
//   IS the page's path: "Patterns/<path>".
//
// Every path must be a node of storybookV2PageTreeOrder (story-group-order.ts);
// validate:catalog fails otherwise, and catalog:sync fails for a v2.0
// Composite with no placement here. Primitives keeps the element-kind
// groups: a primitive is not a section of any one page.
export const V2_PLACEMENT_BY_ID = {
  "project-artifact-list": {
    level: "Composites",
    path: ["Your Teams", "Project Detail"],
  },
  "project-artifact-summary": {
    level: "Composites",
    path: ["Your Teams", "Project Detail"],
  },
  "team-modal": { level: "Composites", path: ["Your Teams"] },
  "sidebar-teams": { level: "Composites", path: ["Your Teams"] },
  "agent-invocations-grid": {
    level: "Composites",
    path: ["Labs", "Agents", "Agent Detail"],
  },
  "documents-view": { level: "Composites", path: ["Shared", "Artifact List"] },
  // PRD-722 (ISS-9349): the tag and reference grid editors every artifact
  // list shares, beside the select and scalar cells.
  "inline-reference-cell": {
    level: "Composites",
    path: ["Shared", "Artifact List"],
  },
  "inline-tag-cell": { level: "Composites", path: ["Shared", "Artifact List"] },
  "artifact-board": {
    level: "Composites",
    path: ["Shared", "Artifact List"],
  },
  "project-artifact-board": {
    level: "Composites",
    path: ["Your Teams", "Project Detail"],
  },
  // ISS-12518: reviewer tooling the prototypes mount, under no product page.
  "prototype-scenario-panel": {
    level: "Composites",
    path: ["Shared", "Prototype Tools"],
  },
  // The Activity tab's parts (ISS-12117), shared by every artifact detail
  // page (Branch, Session, Document…): the timeline, its activity row and its
  // comment box, plus the story-only V2 explorations beside them.
  "activity-card": { level: "Composites", path: ["Shared", "Activity"] },
  "activity-comment-card": {
    level: "Composites",
    path: ["Shared", "Activity"],
  },
  "activity-timeline": { level: "Composites", path: ["Shared", "Activity"] },
  // ISS-12579 (DI-09): the issue page's Activity brief, built on the timeline.
  // Only the Issue Detail design preview (Labs) mounts it, so it sits under
  // that page and stays Preview until the app ships it (ISS-12911).
  "activity-brief": {
    level: "Composites",
    path: ["Labs", "Issues", "Issue Detail"],
  },
  // PLN-2189 T-2.8: the comment box's @-mention member menu, which the
  // document editor's body picker shares.
  "mention-suggestion-list": {
    level: "Composites",
    path: ["Shared", "Activity"],
  },
  // ISS-12520: the directory scope list, shared by first-time setup and the
  // Settings policy view (PRD-805 / PRD-796).
  "directory-scope-list": {
    level: "Composites",
    path: ["Shared", "Data Sync"],
  },
  // ISS-12521: that list with the desktop add-a-directory control.
  "directory-scope-list-with-add": {
    level: "Composites",
    path: ["Shared", "Data Sync"],
  },
  // Sections of every artifact detail page (Branch, Session, Document…).
  "artifact-tab": { level: "Composites", path: ["Shared", "Artifact Detail"] },
  "comments-pane": { level: "Composites", path: ["Shared", "Artifact Detail"] },
  "details-design-preview-host": {
    level: "Composites",
    path: ["Shared", "Artifact Detail"],
  },
  "linked-artifact-groups-table": {
    level: "Composites",
    path: ["Shared", "Artifact Detail"],
  },
  // ISS-12305: the Add Tag picker the Sessions, Branches and Documents lists
  // share.
  "bulk-tag-picker": { level: "Composites", path: ["Shared", "Artifact List"] },
  // ISS-12305: the Tags cell of the Sessions list.
  "session-tags-cell": {
    level: "Composites",
    path: ["Artifacts", "Sessions", "Sessions List"],
  },
  // The editable name cell every artifact list row uses (and Session detail's
  // heading), so it sits with the other shared list parts (ISS-12911).
  "inline-name-cell": {
    level: "Composites",
    path: ["Shared", "Artifact List"],
  },
  // ISS-12532: a session's upload state, for both the Sessions list and
  // Session detail (PRD-807).
  "session-upload-state-badge": {
    level: "Composites",
    path: ["Artifacts", "Sessions"],
  },
  "session-inline-rename": {
    level: "Composites",
    path: ["Artifacts", "Sessions", "Sessions List"],
  },
  "session-trace-chart": {
    level: "Composites",
    path: ["Artifacts", "Sessions", "Session Detail"],
  },
  "session-trace-inspector": {
    level: "Composites",
    path: ["Artifacts", "Sessions", "Session Detail"],
  },
  "session-trace-toolbar": {
    level: "Composites",
    path: ["Artifacts", "Sessions", "Session Detail"],
  },
  "branch-sessions-timeline-panel": {
    level: "Composites",
    path: ["Artifacts", "Branches", "Branch Detail"],
  },
  // ISS-12665: the peak-column fact in both the Session Timeline and the
  // Branch PR timeline headers, so it sits under the page tree they share.
  "timeline-peak-bucket-fact": { level: "Composites", path: ["Artifacts"] },
  "dashboard-scope-control": { level: "Composites", path: ["Dashboard"] },
  // ISS-12522: the data-sync level card, shared by onboarding's consent step,
  // Settings' Connected Devices and the desktop Data & Sync tab.
  "data-sync-policy-choice": {
    level: "Composites",
    path: ["Shared", "Data Sync"],
  },
  "data-sync-level-card": {
    level: "Composites",
    path: ["Shared", "Data Sync"],
  },
  // ISS-12525: the active policy summary, rendered by the policy choice and
  // the desktop Data & Sync tab.
  "data-sync-policy-summary": {
    level: "Composites",
    path: ["Shared", "Data Sync"],
  },
  // ISS-12535: the one-session share exceptions, listed in the policy view
  // beside the policy summary (PRD-807).
  "session-share-exception-list": {
    level: "Composites",
    path: ["Shared", "Data Sync"],
  },
  // ISS-12531: one desktop device's reported policy, read-only on web.
  "device-data-policy": {
    level: "Composites",
    path: ["Shared", "Data Sync"],
  },
  // ISS-12363's Web setup gate rows: a section of the onboarding modal, also
  // drawn in the Getting started card that resumes it.
  "setup-gate-steps": { level: "Composites", path: ["Onboarding"] },
  // ISS-12364: the download step's email capture for a platform with no
  // published installer.
  "desktop-availability-notify-form": {
    level: "Composites",
    path: ["Onboarding"],
  },
  // ISS-12524: the guided-onboarding step that confirms which directories are
  // in scope, built on the Data Sync directory scope list.
  "guided-onboarding-directory-step": {
    level: "Composites",
    path: ["Onboarding"],
  },
  // ISS-12526: the data-sync policy status indicator, a section of every
  // data-controls page (PRD-796), not of any one of them.
  "policy-status-indicator": {
    level: "Composites",
    path: ["Shared", "Data Controls"],
  },
  // ISS-12537: the deletion scope review inside the shared delete
  // confirmation dialog, a section of every data-controls page (PRD-796).
  "deletion-scope-review": {
    level: "Composites",
    path: ["Shared", "Data Controls"],
  },
  // ISS-12538: where a confirmed deletion request stands (pending, completed,
  // failed, unavailable), a section of every data-controls page (PRD-796).
  "deletion-request-tracker": {
    level: "Composites",
    path: ["Shared", "Data Controls"],
  },
  // ISS-12539: where a deletion starts, on session detail and in Settings;
  // it opens the deletion scope review, a part of every data-controls page.
  "deletion-entry-point": {
    level: "Composites",
    path: ["Shared", "Data Controls"],
  },
  // ISS-12528: pause and resume uploads, beside the indicator it reuses.
  "uploads-pause-control": {
    level: "Composites",
    path: ["Shared", "Data Controls"],
  },
  // ISS-12527: the Settings scope editor, beside the indicator it composes.
  "data-controls-scope-editor": {
    level: "Composites",
    path: ["Shared", "Data Controls"],
  },
  // ISS-12529: the upload queue, beside the pause control it sits with.
  "upload-queue-view": {
    level: "Composites",
    path: ["Shared", "Data Controls"],
  },
  // The ISS-10790 artifact detail shell, and its tab set per artifact type.
  "artifact-detail-shell": {
    level: "Patterns",
    path: ["Shared", "Artifact Detail"],
  },
  "branch-artifact-shell": {
    level: "Patterns",
    path: ["Artifacts", "Branches", "Branch Detail"],
  },
  "session-artifact-shell": {
    level: "Patterns",
    path: ["Artifacts", "Sessions", "Session Detail"],
  },
};

// Surfaces is a reviewed list, not a derived result (TAXONOMY.md). These are
// existing Composites promoted to Surfaces in the parity pass that brought
// this taxonomy's Surfaces level up to CE's structure — checked one at a
// time against a real closedloop-ai route or region before promotion, per
// TAXONOMY.md's own rule that this level is hand-curated.
//
// The value is either a plain string (flat: "Surfaces/<label>", for a
// surface that isn't part of the artifact list/detail pattern below) or a
// `[group, label]` pair, same convention DOMAIN_OVERRIDE_BY_ID above already
// uses, giving "Surfaces/<group>/<label>".
//
// Data Sync Tab and Withheld Section were promoted here too, once, and
// un-promoted 2026-09-18 (Mordecai, storybook review): both are a SECTION of a
// larger real page (a settings panel, a diagnostics-surface region), not a
// page of their own — the same test TAXONOMY.md's "Surfaces is a reviewed
// list" already applies to Sessions/Branches/etc, just answered the other
// way here. They fall through to the normal classification instead: Data
// Sync Tab is Electron-specific settings UI, `Composites/Desktop Shell/*`;
// Withheld Section lives in and is used by `packages/app/diagnostics`,
// `Composites/Diagnostics/*`.
//
// Grouping landed 2026-09-16 (Ottilie, today's walkthrough): "I would not
// expect to see branch detail page, I would expect to see branches, and
// under that the branch single-artifact screen and the branch listing
// screen." 90% of the app is two generic composites — a list view and a
// single-artifact view — made concrete per artifact type; the group here is
// that artifact type, so its listing and detail screens sit together
// instead of reading as unrelated flat entries.
export const SURFACE_OVERRIDE_BY_ID = {
  "issues-index-view": ["Issues", "Listing"],
  "pack-detail": ["Packs", "Pack Detail"],
  "packs-workspace": ["Packs", "Packs Workspace"],
  "session-transcript-panel": ["Sessions", "Session Transcript Panel"],
  "branch-comments-workspace": ["Branches", "Comments Workspace"],
  "agent-detail": ["Agents", "Agent Detail"],
  "branch-detail-page": ["Branches", "Branch Detail Page"],
  // The shared shell both the web Session Detail and the desktop one now render
  // (ISS-10796), so it is the real production control a Surfaces entry is for,
  // not a story-local approximation. Registered here because the normal
  // classification reads "shell" as a Primitive — `APP_CORE_RECLASSIFY_PATTERN`
  // matches `surface`, not `shell`.
  "agent-session-shell-view": ["Sessions", "Agent Session Shell View"],
  "agent-session-detail-view": ["Sessions", "Session Detail"],
  "session-detail-view": ["Sessions", "Session Detail (Desktop Shell)"],
  // The real /sessions route renders exactly this component (via
  // sessions-list-v2-host.tsx) behind the grid-table-v2 gate — see the
  // story file's own header comment. Supersedes the hand-composed
  // apps/storybook/stories/surfaces/sessions.stories.tsx, removed in favor
  // of this one (2026-09-16, per Ottilie/Marisol: Surfaces must be the real
  // production control, not a story-local approximation). Labeled Listing,
  // not Sessions, so it doesn't read as Surfaces/Sessions/Sessions.
  "sessions-list-surface-v2": ["Sessions", "Listing"],
  // ISS-10797: the whole Branch detail page composed on the canonical
  // artifact shell, beside the bespoke `branch-detail-page` it replaces.
  "branch-shell-view": ["Branches", "Branch Shell View"],
};

// Sessions is its own product surface (the `/sessions` route, a peer of
// `/agents` and `/branches`) even though its code lives under
// packages/app/agents/components/sessions/ for historical reasons —
// AGENTS.md's own words, carried forward from the old App Core/ scheme
// rather than re-derived. It is promoted to a top-level domain, not a
// sub-family of Agents, to match.
//
// Agents itself is still oversized (62 stories once Sessions' 19 move out)
// and splits by where the rest of the code lives under
// packages/app/agents/components/, matching CE's Detail/Sessions/Trace
// pattern with closedloop-ai's own directory names (see TAXONOMY.md).
export function resolveAgentsPackageDomain(sourcePath) {
  if (sourcePath.includes("/components/sessions/")) {
    return ["Sessions"];
  }
  if (sourcePath.includes("/components/detail/")) {
    return ["Agents", "Detail"];
  }
  if (sourcePath.includes("/components/workspace/")) {
    return ["Agents", "Workspace"];
  }
  return ["Agents", "General"];
}

export function domainForFeature(feature) {
  if (FEATURE_TO_DOMAIN[feature]) {
    return FEATURE_TO_DOMAIN[feature];
  }
  if (DOMAIN_TITLE_OVERRIDES[feature]) {
    return DOMAIN_TITLE_OVERRIDES[feature];
  }
  return feature
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// --- Desktop shell (apps/desktop/src/renderer/components/**) -------------
//
// All 21 are Electron-boundary-specific with no web equivalent, so they sit
// together as one domain rather than being split by internal complexity.
export const DESKTOP_DOMAIN = "Desktop Shell";
