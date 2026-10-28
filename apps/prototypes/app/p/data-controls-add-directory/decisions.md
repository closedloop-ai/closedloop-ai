# Decisions for data-controls-add-directory

## Directory scope list with add, a new composite over the shipped list
- kind: component
- by: agent
- when: first build
- why: ISS-12520 is closed and its contract is final, so the add control composes DirectoryScopeList unchanged instead of growing a slot on it. The add copy is its own AddDirectoryControlCopy type so this ticket's unapproved wording stays separate from DirectoryScopeListCopy.
- component: DirectoryScopeListWithAdd
- path: packages/app/shared/components/directory-scope-list-with-add.tsx
- call: new
- considered: DirectoryScopeList with a new add slot (ruled out, closed contract); CheckboxTree directly (would fork the list's row meaning)

## Alert for the three refusals
- kind: component
- by: agent
- when: first build
- why: A refused pick is a bordered, tinted message with a leading icon, which is exactly what Alert ships, and its role="alert" announces the refusal on arrival.
- component: Alert
- path: packages/design-system/components/ui/alert.tsx
- call: reused

## Outline small Button for the trigger
- kind: component
- by: agent
- when: first build
- why: Adding a directory is secondary to reviewing the list, so the trigger is the quiet outline button with a folder-plus icon and a visible label, not a primary button.
- component: Button, outline small
- path: packages/design-system/components/ui/button.tsx
- call: reused

## Each refusal gets its own tone and icon
- kind: design
- by: agent
- when: first build
- why: AC-002 asks for three distinct error states and no copy exists yet, so the states have to be told apart without words. Duplicate is neutral with a copy icon because nothing went wrong, unreadable is a warning with a folder-x icon, and protected is info with the same lock the automatic-exclusion group draws on its rows.

## Trigger sits above the list
- kind: design
- by: agent
- when: first build
- why: DirectoryScopeList renders its read-only protected group last, so a control placed after the list would sit under the protected folders rather than beside the directories it adds to. Above the list keeps it next to the tree it changes and next to the empty state when nothing was discovered.

## Outcome precedence: duplicate, then protected, then unreadable
- kind: design
- by: agent
- when: first build
- why: A listed directory that has gone unreadable already says so on its own row, so the useful answer is that it is already there. A TCC denial also probes as blocked, so protected is checked before unreadable or every protected pick would read as unreadable.

## Web hides the control instead of explaining it
- kind: design
- by: agent
- when: first build
- why: AC-003 allows absent or explained. Explaining needs wording nobody has approved, and absent needs none, so the web host passes no picker and the control does not render.

## A successful add is announced, not drawn
- kind: design
- by: agent
- when: first build
- why: The new row with its newly discovered badge is the visible confirmation, so a success alert would say it twice. Screen readers do not hear a tree row appear, so a visually hidden status region announces the add (WCAG 4.1.3).

## An added directory arrives excluded
- kind: design
- by: agent
- when: first build
- why: The brief adds the pick as a newly discovered entry and says nothing about including it, so the control does not change includedIds. Whether an explicit add should also include the directory is open for review.

## A refusal stays until the next pick
- kind: design
- by: agent
- when: first build
- why: The alert describes the last pick, so it clears when the next pick starts and otherwise stays, keeping the explanation readable instead of timing it out.

## A failed picker call goes to the host
- kind: design
- by: agent
- when: first build
- why: A rejected IPC call is not one of the four outcomes and has no wording, so the control returns to idle and hands the error to the host's onPickError rather than swallowing it or drawing an invented message.

## Every copy slot is a glyph
- kind: deviation
- by: agent
- when: first build
- why: ISS-12521 is outside the ISS-12520 placeholder ruling (Nerys, 2026-10-15), so the prototype and stories show a single ellipsis glyph in every slot, including the shared list's, and prove each state through data-state, data-outcome and the icons.

## ISS-12521's copy is approved; the shared list's is not
- kind: deviation
- by: author
- when: after first review
- why: Cosimo Corrigan supplied `trigger`/`added`/`duplicate`/`unreadable`/`protectedFolder` and the demo's picker legend directly, superseding the glyph-only treatment above for those slots. `DirectoryScopeListCopy` (ISS-12520) is untouched, has no approval from this ticket's thread, and keeps showing a glyph.

## The pick switcher stands in for the native picker
- kind: design
- by: agent
- when: first build
- why: The sandbox has no Electron IPC. The switcher above the surface chooses which fictional path the next Add returns, labelled by the path itself so it adds no words, and lives in the mock host because a production-bound route may render only its main landmark.

## Design review (2026-10-16): a successful pick arrives included
- kind: deviation
- by: author
- when: after design review
- why: Supersedes "An added directory arrives excluded" above. The critic's reasoning (and Cosimo Corrigan's call): a user who drives the native picker is choosing the directory on purpose, unlike a row discovery surfaces unprompted, so it should land checked rather than need a second, undiscoverable step. See `DirectoryScopeListWithAdd` (packages/app/shared/components/directory-scope-list-with-add.tsx).

## Design review (2026-10-16): success renders in the same alert slot
- kind: deviation
- by: author
- when: after design review
- why: Supersedes "A successful add is announced, not drawn" above. The critic's point: the new-row-as-confirmation only works on a four-row list; with a real discovered population the row lands out of view and a sighted user sees nothing happen. The sr-only announcement is now redundant with the reused Alert's own role="alert" and is removed.

## Design review (2026-10-16): duplicate means selected, by inheritance
- kind: deviation
- by: author
- when: after design review
- why: Supersedes the implicit "listed = duplicate" reading in "Each refusal gets its own tone and icon" and "Outcome precedence" above. The critic found the approved copy ("Already selected") false for a listed-but-unselected row, and separately that a subfolder of an included parent (not even a row yet) read as a fresh Added rather than already-in-scope. Duplicate now checks coverage by the current selection (direct id match or an included ancestor's path prefix), not row membership; a listed-but-unselected pick resolves to Added and is included rather than re-added. See `DirectoryScopeListWithAdd`.

## Design review (2026-10-16): protected shares Unreadable's tone, not Duplicate's
- kind: deviation
- by: author
- when: after design review
- why: Supersedes the "protected is info" line in "Each refusal gets its own tone and icon" above. The critic's point: an info tone read as softer than the warning given to a merely temporary read failure, backwards from how serious each refusal actually is — a permanent policy exclusion and a denied read are both things the user cannot override from this control. Icon, not tone (both reuse Alert's existing `warning` variant), now tells the two apart.

## Open, not resolved this round: collapsed-parent duplicates and nested nuance
- kind: design
- by: agent
- when: after design review
- why: The critic flagged two cases this build does not settle: a duplicate pick nested under a collapsed parent has no visible row to point at, and the exact nesting/placement rule for a brand-new subfolder of an already-included parent is still the host's guess. Left open pending a decision, per the critic's own framing ("that needs a decision").

## Round 2: the nesting question now BLOCKS the AC-004 build
- kind: design
- by: agent
- when: after second design review
- why: The critic's round-2 pass found the path-prefix coverage check (added to fix round-1 item 3) and the tree's structural inheritance are now two different definitions of "selected": picking `~` includes it as a new sibling row while `~/sandbox` stays visibly unchecked, yet coverage already reports `~/sandbox` as covered. The open item above was framed as cosmetic (a collapsed parent's duplicate has nothing to point at); it no longer is, because the DUPLICATE ANSWER ITSELF now depends on resolving it. The AC-004 builder must settle this before shipping, not just before polishing.

## Round 2: should an unreadable-but-unselected row refuse at all?
- kind: design
- by: agent
- when: after second design review
- why: The critic's open question: ISS-12520 made an unavailable row fully toggleable (its own checkbox includes it despite being unreadable), but the add control refuses the same pick with "This directory is currently unreadable". Two controls on one screen can give two different answers for the same folder. Left open for a human decision, per the critic's framing ("either is defensible").
