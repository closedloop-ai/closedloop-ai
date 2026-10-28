/** PRD-725's release record stays separate so the long-lived history story shrinks. */
export const PRD725_RELEASE = {
  releaseId: "prd725-4.0.1",
  version: "4.0.1",
  date: "2026-10-21",
  summary:
    "Manual artifact hierarchy placement (PRD-725): the stable Documents View entry gains the pointer, keyboard, responsive, permission and interaction-state matrix, and the stable Project Detail page gains its production-adapter Manual Ordering state. Frozen v1.0 entries are unchanged.",
  contents: [
    { level: "Primitives", entries: 4, stories: 23 },
    { level: "Composites", entries: 81, stories: 585 },
    { level: "Patterns", entries: 13, stories: 71 },
    { level: "Surfaces", entries: 61, stories: 322 },
  ],
  changes: [
    "Composites/Shared/Artifact List/Documents View gains Manual Ordering, Hover, Focus Visible, Selected, Editing, Dragging, Drag Over, Partial, Error, Disabled, Read Only, No Permission, Narrow, Overflow, Dark, Pointer Placement and Keyboard Placement; Loading and Empty remain its existing states.",
    "Surfaces/Your Teams/Project Detail gains Manual Ordering on the live route's default All Artifacts tab through the production adapter.",
    "Counts are from storybook index after stacking this release above main's 4.0.0 history.",
  ],
} as const;
