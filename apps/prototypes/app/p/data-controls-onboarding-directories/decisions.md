# Decisions for data-controls-onboarding-directories

## Onboarding directory step, a new step over the shipped list and add control
- kind: component
- by: agent
- when: first build
- why: ISS-12520 and ISS-12521 are on main with closed contracts, so the step composes DirectoryScopeListWithAdd unchanged inside the guided-onboarding step layout instead of growing either of them.
- component: GuidedOnboardingDirectoryStep
- path: packages/app/onboarding/components/guided-onboarding-directory-step.tsx
- call: new
- considered: a new phase in GUIDED_ONBOARDING_PHASES (ruled out until design review and approved copy); a Settings-style scope editor (ISS-12527 owns that surface)

## GuidedOnboardingStepLayout for the frame
- kind: component
- by: agent
- when: first build
- why: Every guided-onboarding step draws eyebrow, title, description, body and a Back/primary footer through this layout, so the new step sits in the card exactly as its neighbours do.
- component: GuidedOnboardingStepLayout, GuidedOnboardingBackButton
- path: packages/app/onboarding/components/guided-onboarding-step-layout.tsx
- call: reused

## The step comes right before the sync-level step
- kind: design
- by: author
- when: first build
- why: Operator decision on ISS-12524 (th_hdf9HnMCIvHymYZI13FwD): after sign-in and organization, immediately before sync level (AC-001). Its exits are therefore only Back and Continue, and Continue hands the confirmed scope to the host.

## Zero directories is a valid answer
- kind: design
- by: author
- when: first build
- why: Operator decision on ISS-12524 (AC-003): Continue is never disabled. Nothing is in scope for upload, and the sync-level step treats that as local-only, so the step never blocks onboarding. The list's own no-selection state says so; the step adds no words.

## Web shows the list's empty state
- kind: design
- by: author
- when: first build
- why: Operator decision on ISS-12524 (AC-004), following ISS-12521's "web hides the control" decision: web has no picker and no local discovery, so the host passes no add adapter and no entries, and the list renders its existing empty state.

## What a first run starts with is the host's call
- kind: design
- by: agent
- when: first build
- why: includedIds is controlled. Whether discovered directories arrive included or not is a product decision the step should not bake in, so the fixtures show part of the list included and the zero-selected story shows the other end.

## Existing sessions in excluded directories are out of scope
- kind: design
- by: author
- when: first build
- why: Operator decision on ISS-12524: a first-run step has no prior uploads, so excluded directories simply stay local; the step shows no retroactive or deletion state.

## Copy is placeholder except two reused strings
- kind: deviation
- by: author
- when: first build
- why: The step's and the list's slots have no approved wording, so each shows "Placeholder: <slot>" under the story-fixture exception (Nerys, 2026-10-15, th_Dc0RuSiAdyCvLQpC_X2G4). The add control reuses ISS-12521's approved copy, and Continue reuses the sync step's shipped label. Proposed wording is on the ISS-12524 ticket for owner review.

## The picker always returns one fresh directory
- kind: design
- by: agent
- when: first build
- why: ISS-12521's prototype already walks every pick outcome, so this route shows the onboarding flow with one readable pick rather than repeating that switcher.
