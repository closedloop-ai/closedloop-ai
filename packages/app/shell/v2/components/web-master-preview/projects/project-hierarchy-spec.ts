/**
 * PRD-595 / ISS-6560 — Project artifact hierarchy prototype contract.
 *
 * Canonical traceability:
 * - ISS-6560 "Project screens v2", PJV-01 through PJV-16, owns the
 *   project-specific requirements represented here.
 * - ISS-6152 "Unified artifact lists, tables, filters, and saved views",
 *   UAL-01 through UAL-10, owns the shared collection interactions consumed
 *   here. Changes to those interactions must be validated outside Projects too.
 * - This source comment and the project fixtures are implementation evidence;
 *   the live feature documents remain the canonical requirements.
 * - Delivery evidence: GitHub PR
 *   https://github.com/closedloop-ai/closedloop-ai/pull/5074 and Vercel preview
 *   https://prototypes-git-prototype-project-screens-v2-status-integration.preview.stage.example/p/web-master/projects/sprint-0810
 *
 * Scope boundary:
 * - Enable parent/child hierarchy only in project artifact views.
 * - Do not enable hierarchy in single-artifact-type views. Showing descendants
 *   of other artifact types there would create mixed-type tables and break the
 *   homogeneous column assumptions of those views.
 * - Treat every displayed metrics card as placeholder prototype content only.
 *   Each card requires its own specification before implementation, including
 *   its definition, source data, calculation and comparison assumptions, and
 *   expected behavior for missing or incomplete data.
 * - Intentionally retire the production "Quality Score" field. The production
 *   implementation must remove it from persistence and every product view; do
 *   not carry it forward or relabel it as another generic outcome score.
 *
 * List view:
 * - Render at most four artifact levels, including the root.
 * - Inherit the shared artifact list's tabular narrow-width behavior. Keep the
 *   hierarchy in the horizontally scrollable grid rather than replacing rows
 *   with cards that erase the spatial parent/child relationship.
 * - Expand and collapse each ancestor independently.
 * - Group and sort logical root artifacts only; keep each visible subtree intact.
 * - Project collections do not have a date-range concept. Do not render a date
 *   picker or read, write, save, filter, compare metrics, or preserve a `range`
 *   route parameter through hidden shared-control state.
 * - Default project lists to grouping by unified status. Users can clear the
 *   grouping to return to one ungrouped list; persist that explicit choice as
 *   `group=none` so a reload does not silently restore the project default.
 * - Evaluate filters against every artifact level.
 * - When a descendant matches, retain its full ancestor path without a special
 *   visual treatment or supplemental match-count messaging.
 * - Hide nonmatching sibling branches and automatically open matching paths.
 * - Restore the user's pre-filter expansion state when filters are cleared.
 * - Manual ordering is an explicit shared-list capability independent of
 *   inline creation but declared alongside hierarchy, whose row owns the
 *   reorder handle (ISS-10480). Project views enable it; homogeneous artifact
 *   lists do not. It is available only when automatic sorting is cleared. While
 *   sorted, remove drag handles and reorder cursors instead of leaving a
 *   disabled drag control visible.
 * - A root moves with its complete descendant subtree. Children reorder within
 *   their sibling scope, may move across parents, and may be promoted to root.
 * - Preserve every surviving ancestor's pre-drag expanded/collapsed state.
 *   Before, after, and section moves never open artifacts. An explicit inside
 *   drop opens only its direct destination parent; nodes that cease to have
 *   children discard stale expansion state. Undo restores the pre-drag state.
 * - Use explicit before, inside, and after drop targets so reparenting cannot be
 *   confused with reordering. Vertical pointer position chooses before/after;
 *   horizontal movement chooses nesting. Reject cycles and moves beyond four
 *   levels by withholding the drop target, without an explanatory error toast.
 * - The insertion indicator is the committed sibling position at every depth.
 *   Row-edge targets win over horizontal nesting so dropping before or after a
 *   child reparents into that child's parent at that exact index. An inside
 *   target inserts as the parent's first child, directly beneath its indicator;
 *   later child positions use the surrounding children's before/after targets.
 * - Keep the six-dot handle as the only list-view drag origin. Title and data-
 *   cell whitespace remain available for row selection; links, values, editors,
 *   menus, and selection controls retain their normal interactions.
 * - Use the Asana-style cursor contract consistently: the handle uses grab and
 *   grabbing; links, expanders, completion controls, metadata values, menus, and
 *   add rows use pointer; active text editors use text. Fixed unified-status
 *   section headers collapse/expand with pointer and are never draggable.
 * - Preserve project-specific title behavior: clicking a title navigates to the
 *   artifact's type-specific detail view. The hover-revealed pencil, Enter, or
 *   F2 starts inline title editing; this intentionally differs from Asana's
 *   single-click title editing so navigation remains predictable.
 * - Use a neutral row hover, a subtle blue keyboard-focus row, and a persistent
 *   subtle blue selected-row background so the interaction state is visible
 *   without overpowering status, priority, or selection controls.
 * - Group-to-group movement applies only to roots. Crossing a group updates the
 *   root's grouped metadata atomically; descendants stay attached and retain
 *   their own status, owner, priority, and other fields.
 * - Match Asana's empty-section drop feedback: while a root is dragged over an
 *   expanded empty group, render a first-row-sized landing slot with a blue
 *   insertion rule directly beneath the group header. Do not highlight the
 *   entire section or add instructional placeholder copy.
 * - Dropping on a list group header inserts at the start of that group. Dropping
 *   on board-lane whitespace inserts at the end; card-edge targets select exact
 *   positions between existing roots. Empty groups have one equivalent slot.
 * - Treat Issue as the primary/default artifact type for project creation.
 *   Every expanded group, including empty groups, exposes an "Add issue" row.
 * - Match the Issue artifact list's keyboard creation contract: the add row is
 *   keyboard activatable, Enter commits and advances to another draft, Escape
 *   cancels an empty draft, and Enter after editing an existing title inserts
 *   a draft row immediately after it. New issues inherit the current project
 *   and the destination group's metadata.
 * - Pure sibling reordering is quiet. Parent, project, or group metadata changes
 *   produce one compact receipt describing the semantic changes and descendant
 *   count, with one atomic Undo action. Equivalent keyboard and menu actions
 *   must remain available.
 * - Match Asana's multi-select contract in list view: pointer-drag from any
 *   non-interactive row surface across adjacent rows to select the contiguous
 *   range. Suppress native text selection for the complete gesture. Links,
 *   editors, controls, and the six-dot reorder handle keep their own behavior.
 *   Shift-click selects a range; Cmd/Ctrl-click toggles non-adjacent rows;
 *   Shift+Arrow and keyboard shortcuts remain equivalent paths. Show the shared
 *   selection-action toolbar for one selected artifact when the container
 *   supplies a valid single-item action such as Move to project; otherwise show
 *   the bulk-action toolbar as soon as two or more artifacts are selected.
 * - Match Asana's dismissal boundary across the complete screen. Any ordinary
 *   primary click first clears the complete selected set, including Add issue,
 *   filters, grouping, inline editors, links, group headers, and other controls.
 *   A row or card may then replace the set with its own item. Shift/Cmd/Ctrl
 *   selection gestures preserve and extend the current set. Explicit selected-
 *   set controls—the bulk toolbar, its portaled menus, row move controls, and
 *   list/board drag origins—preserve the set so their action can complete.
 * - Priority and unified Status sort through stable numeric ranks rather than
 *   their display labels. Ascending Priority is Urgent, High, Medium, Low;
 *   ascending Status follows Todo, In Progress, In Review, Done, Canceled.
 *   Descending reverses the corresponding order.
 * - A drag started from the six-dot handle of any selected artifact moves the
 *   selected set atomically. Normalize selected descendants away when their
 *   selected ancestor already represents the same subtree, preserve visible
 *   order, validate every moved subtree before committing, and keep one Undo
 *   receipt for the complete gesture. A selected child without a selected
 *   ancestor remains independently movable.
 * - Selecting one or more hierarchy rows exposes "Move to project" in the
 *   shared selection-action toolbar for each other visible team project; do not
 *   add a second project-move icon to every row. Moving a root transfers its
 *   complete subtree.
 *   Moving a child transfers its complete subtree, clears its source parent,
 *   and promotes it to a destination root. A selected set is normalized so a
 *   selected ancestor carries its selected descendants only once. The source
 *   project updates immediately and one receipt names the project change,
 *   promoted children, moved descendant count, and an atomic Undo action.
 *
 * Persistence contract:
 * - Store root rank in project membership (or on Artifact only while project
 *   membership remains strictly singular).
 * - Store child rank on the parent/child relationship, not on the child, since
 *   sibling position is relative to a particular parent.
 * - Persist reparenting, ranking, and grouped-field changes atomically with
 *   cycle/depth validation and an auditable inverse transaction for Undo.
 *
 * Artifact activity contract:
 * - Capture every artifact metadata change in the artifact activity feed,
 *   regardless of whether it came from inline editing, a bulk action, an API,
 *   automation, or drag and drop.
 * - Each activity record must identify who changed what and when: actor,
 *   timestamp, artifact, field or relationship, previous value, new value, and
 *   the interaction source. Related changes from one gesture share a transaction
 *   id so the feed can present them as one understandable action.
 * - Drag activity must explicitly record sibling-order changes, parent changes,
 *   root/child transitions, project moves, and section/group metadata changes.
 *   Include the number of descendants moved with a subtree, but create child
 *   activity entries only when that child's own metadata or relationships
 *   actually changed.
 * - Undo never deletes the original activity. Record a linked inverse activity
 *   transaction showing who restored which prior values and when.
 *
 * Board view:
 * - Render root artifacts only. Lane changes update root group metadata; child
 *   artifacts stay hidden and move with the root without changing their fields.
 * - Use pointer-driven dragging rather than native HTML drag events so cards
 *   follow Asana's consistent activation threshold, cursor, preview, insertion,
 *   empty-lane targeting, and horizontal/vertical auto-scroll behavior.
 * - The whole non-interactive card surface is draggable and retains its resting
 *   pointer cursor. During drag, replace the source with a blank card-shaped
 *   placeholder and render a lightweight elevated card preview under the pointer.
 * - Use the shared artifact board card everywhere: compact identity row (type,
 *   slug, optional Issue completion control), title-first hierarchy, optional
 *   status detail, and a field-driven metadata footer. View Options determine
 *   whether priority, owner, tags, comments, and updated time appear.
 * - Never repeat a primary or secondary grouping attribute on its cards. This
 *   applies to every configurable grouping field: status omits both unified
 *   status and its type-specific detail, owner omits the avatar, priority omits
 *   the priority label, tags omit tag chips, and type omits the type icon.
 * - A completion control is valid only for user-controlled Issues. Documents,
 *   Branches, Prototypes, source-controlled artifacts, and other artifact types
 *   keep type identity and type-specific navigation without a task checkbox.
 * - Keep card actions progressively disclosed on hover, focus, or open state;
 *   clicking unused card space selects while the title opens the type-specific
 *   artifact view. Do not introduce a generic Asana-style detail drawer.
 * - Support Asana-style inline editing on every mutable field rendered on a
 *   card: hover/focus reveals title editing; status, priority, owner,
 *   collaborators, and tags open their established shared editors in place.
 *   Grouped attributes remain omitted, derived values remain read-only, and
 *   source-managed status exposes its authority instead of accepting a change.
 * - Keep lanes visually lighter than their cards with compact sticky headers,
 *   subtle neutral backgrounds, and 320px minimum widths. Give cards a relaxed
 *   136px minimum footprint, a larger title, and two tiers of wrapping metadata
 *   so enabled fields remain readable instead of compressing into one strip.
 * - Card-to-card and lane drops move the complete selected root set when the
 *   dragged card is selected. Preserve selection and the bulk-action bar after
 *   the move. Empty lanes use a card-shaped insertion slot, never a full-lane
 *   highlight.
 * - Use 100ms transform, shadow, and margin transitions with the shared
 *   `cubic-bezier(0.05, 0.4, 0.2, 1)` motion curve.
 */
export const projectArtifactHierarchySpec = {
  maxVisibleLevels: 4,
} as const;
