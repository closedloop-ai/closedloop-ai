export const ResponsiveNarrowGridviewEvidenceKind = {
  Adapter: "adapter",
  Champion: "champion",
  DataDependency: "data-dependency",
  Defect: "defect",
  NonGoal: "non-goal",
} as const;

export type ResponsiveNarrowGridviewEvidenceKind =
  (typeof ResponsiveNarrowGridviewEvidenceKind)[keyof typeof ResponsiveNarrowGridviewEvidenceKind];

export const ResponsiveNarrowGridviewDisposition = {
  Adopted: "adopted",
  DefectFixed: "defect-fixed",
  Preserved: "preserved",
  UnchangedNonGoal: "unchanged-non-goal",
} as const;

export type ResponsiveNarrowGridviewDisposition =
  (typeof ResponsiveNarrowGridviewDisposition)[keyof typeof ResponsiveNarrowGridviewDisposition];

export type ResponsiveNarrowGridviewAuditRow = {
  behavior: string;
  disposition: ResponsiveNarrowGridviewDisposition;
  evidence: string;
  id: string;
  kind: ResponsiveNarrowGridviewEvidenceKind;
  owner: string;
  paths: readonly string[];
};

/** ISS-9377: tracked decomposition of every approved PRD-727 behavior. */
export const RESPONSIVE_NARROW_GRIDVIEW_AUDIT_LEDGER = [
  {
    behavior: "Viewport-based one-column Name projection",
    disposition: ResponsiveNarrowGridviewDisposition.Adopted,
    evidence: "Shared header, row, group, tree, focus, and ARIA render path",
    id: "RNG-AUDIT-001",
    kind: ResponsiveNarrowGridviewEvidenceKind.Champion,
    owner: "GridTableV2",
    paths: ["packages/design-system/components/ui/grid-table-v2.tsx"],
  },
  {
    behavior: "Sessions row mapping, status, tags, Favorite, and actions",
    disposition: ResponsiveNarrowGridviewDisposition.Adopted,
    evidence: "Domain renderLead/renderCell and product compatibility adapter",
    id: "RNG-AUDIT-002",
    kind: ResponsiveNarrowGridviewEvidenceKind.Adapter,
    owner: "SessionsListSurfaceV2",
    paths: [
      "packages/app/agents/components/sessions/sessions-list-surface-v2.tsx",
    ],
  },
  {
    behavior: "Branches row mapping, syncing precedence, tags, and actions",
    disposition: ResponsiveNarrowGridviewDisposition.Adopted,
    evidence: "Approved Branches grid adapter",
    id: "RNG-AUDIT-003",
    kind: ResponsiveNarrowGridviewEvidenceKind.Adapter,
    owner: "BranchesGridV2",
    paths: ["packages/app/branches/components/branches-grid-v2.tsx"],
  },
  {
    behavior: "Documents, project, and Generic Artifact production adoption",
    disposition: ResponsiveNarrowGridviewDisposition.Adopted,
    evidence:
      "ProductGridTableV2 callers and default-off compatibility adapters",
    id: "RNG-AUDIT-004",
    kind: ResponsiveNarrowGridviewEvidenceKind.Adapter,
    owner: "Product grid callers",
    paths: [
      "packages/app/documents/components/table/document-row.tsx",
      "packages/app/shared/components/product-grid-table-v2.tsx",
    ],
  },
  {
    behavior: "Closed-by-default web and Desktop rollout",
    disposition: ResponsiveNarrowGridviewDisposition.Preserved,
    evidence: "One PostHog key plus viewport media query",
    id: "RNG-AUDIT-005",
    kind: ResponsiveNarrowGridviewEvidenceKind.DataDependency,
    owner: "Responsive narrow Gridview feature-flag adapter",
    paths: [
      "packages/app/shared/feature-flags/use-responsive-narrow-gridview.ts",
    ],
  },
  {
    behavior: "Documents must not re-enter container-width cards while flag on",
    disposition: ResponsiveNarrowGridviewDisposition.DefectFixed,
    evidence: "DocumentRow flag-on veto plus production routing coverage",
    id: "RNG-AUDIT-006",
    kind: ResponsiveNarrowGridviewEvidenceKind.Defect,
    owner: "DocumentRow",
    paths: ["packages/app/documents/components/table/document-row.tsx"],
  },
  {
    behavior: "Explicit Board/Card view",
    disposition: ResponsiveNarrowGridviewDisposition.UnchangedNonGoal,
    evidence: "Separate PRD-724 surface, never the responsive fallback",
    id: "RNG-AUDIT-007",
    kind: ResponsiveNarrowGridviewEvidenceKind.NonGoal,
    owner: "Board/Card surfaces",
    paths: ["packages/app/documents/components/table/table-view-menu.tsx"],
  },
  {
    behavior: "Selection reconciliation and toolbar model",
    disposition: ResponsiveNarrowGridviewDisposition.UnchangedNonGoal,
    evidence: "Owned by #8900 and #8922 respectively",
    id: "RNG-AUDIT-008",
    kind: ResponsiveNarrowGridviewEvidenceKind.NonGoal,
    owner: "Adjacent active work",
    paths: [
      "packages/design-system/components/ui/table-bulk-action-bar.tsx",
      "packages/design-system/components/ui/grid-table-toolbar.tsx",
    ],
  },
] satisfies readonly ResponsiveNarrowGridviewAuditRow[];

export type ResponsiveNarrowGridviewInformationRule = {
  disposition: ResponsiveNarrowGridviewDisposition;
  id: string;
  narrow: string;
  owner: string;
  paths: readonly string[];
  wide: string;
};

/** ISS-9520: the information-preservation contract across responsive forms. */
export const RESPONSIVE_NARROW_GRIDVIEW_INFORMATION_RULES = [
  {
    id: "RNG-INFO-001",
    disposition: ResponsiveNarrowGridviewDisposition.Adopted,
    narrow: "Only the Name column header remains",
    owner: "GridTableV2 header",
    paths: ["packages/design-system/components/ui/grid-table-v2.tsx"],
    wide: "Every configured visible column remains",
  },
  {
    id: "RNG-INFO-002",
    disposition: ResponsiveNarrowGridviewDisposition.Adopted,
    narrow: "Status icon precedes the ellipsized title",
    owner: "Domain lead adapters",
    paths: [
      "packages/app/agents/components/sessions/session-name-lead-cell.tsx",
      "packages/app/branches/components/approved-branches-grid-adapter.tsx",
    ],
    wide: "Existing status and title cells remain",
  },
  {
    id: "RNG-INFO-003",
    disposition: ResponsiveNarrowGridviewDisposition.Preserved,
    narrow: "Group header spans the one-column row",
    owner: "Shared group renderer",
    paths: ["packages/design-system/components/ui/group-section-header.tsx"],
    wide: "Group header spans the complete grid",
  },
  {
    id: "RNG-INFO-004",
    disposition: ResponsiveNarrowGridviewDisposition.Preserved,
    narrow: "Tree disclosure and level remain on the Name row",
    owner: "Shared row renderer",
    paths: ["packages/design-system/components/ui/grid-table-v2-row.tsx"],
    wide: "Tree disclosure and level remain on the identity column",
  },
  {
    id: "RNG-INFO-005",
    disposition: ResponsiveNarrowGridviewDisposition.Preserved,
    narrow: "Favorite and More remain reachable at the trailing edge",
    owner: "Domain utility/action adapters",
    paths: ["packages/design-system/components/ui/grid-table-v2-row.tsx"],
    wide: "Existing utility and action columns remain",
  },
  {
    id: "RNG-INFO-006",
    disposition: ResponsiveNarrowGridviewDisposition.UnchangedNonGoal,
    narrow: "Tags are not shown in the narrow row (ISS-12959)",
    owner: "Wide Tags column",
    paths: [
      "packages/app/agents/components/sessions/sessions-list-grid-v2.tsx",
      "packages/app/branches/components/branches-grid-v2.tsx",
    ],
    wide: "Tags remain in their configured data column",
  },
  {
    id: "RNG-INFO-007",
    disposition: ResponsiveNarrowGridviewDisposition.Preserved,
    narrow: "Select-all remains in the single header",
    owner: "Shared header selection control",
    paths: ["packages/design-system/components/ui/grid-table-v2.tsx"],
    wide: "Select-all remains in the identity header",
  },
  {
    id: "RNG-INFO-008",
    disposition: ResponsiveNarrowGridviewDisposition.Preserved,
    narrow: "After-row and inline-create content uses the single track",
    owner: "Shared after-row renderer",
    paths: ["packages/design-system/lib/grid-table-v2-after-row.ts"],
    wide: "After-row content uses the complete track template",
  },
] satisfies readonly ResponsiveNarrowGridviewInformationRule[];
