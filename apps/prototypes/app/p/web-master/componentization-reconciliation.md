# Web Master onboarding componentization matrix

Oracle: PR #5968 at `dfd3e59875e5269c67a1d80105e991878f731fe7`.
Implementation authority: the design-system catalog and the `packages/app`
onboarding domain. Each prototype mode/user scenario resumes its own wizard
snapshot after reload and can be reset explicitly. The approved decisions in
the Overrides section resolve the prototype/production conflicts found during
the pre-implementation audit.

| Contract ID | Observable contract | Oracle evidence | Disposition | Canonical owner | Replacement evidence |
| --- | --- | --- | --- | --- | --- |
| WM-001 | Opening setup blocks interaction with the dashboard | `guided-ftue-modal.test.tsx`: blocking overlay | REUSE | DS `Dialog` modal overlay | dialog test + story |
| WM-002 | The overlay is a real modal with trapped focus/inert background | User request; PR review | EXTEND | DS `Dialog` default modal behavior | dialog focus/escape test |
| WM-003 | Setup cannot be dismissed with Escape or outside interaction | modal callbacks in prototype | EXTEND | DS `DialogContent` event seams + OV-WM-003 | dialog test |
| WM-004 | No close affordance is rendered | welcome test | REUSE | DS `DialogContent.showCloseButton` | dialog test |
| WM-005 | Dialog retains the prototype's exact 900×680 maximum geometry and fits compact viewports with reachable actions | modal class recipe; Pascoe compact-width contract | EXTEND | DS Dialog size contract + OV-WM-005 | compact story |
| WM-006 | Each step supplies one accessible title and description | role assertions in modal tests | REUSE | DS `DialogTitle`/`DialogDescription` | step tests |
| WM-007 | Welcome copy and privacy link are unchanged | welcome tests | DOMAIN | welcome step | dialog test/story |
| WM-008 | Desktop and Web welcome actions differ | Web welcome test | DOMAIN | welcome step configuration | mode stories/test |
| WM-009 | Prototype design notes remain prototype-only and toggleable | annotation test | DOMAIN | prototype annotation slot | annotation test |
| WM-010 | Back is absent on welcome and delegates elsewhere | Back test | DOMAIN | shared wizard footer | navigation tests |
| WM-011 | Phase history returns to the exact previous step | `ftue-navigation.test.ts` | DOMAIN | prototype controller | navigation tests |
| WM-012 | Desktop discovery starts before account setup | shell transition graph | DOMAIN | prototype controller | controller test |
| WM-013 | Analysis progress is announced and Continue waits for progress > 0 | analysis tests | REUSE | DS `Progress` + analysis step | modal tests |
| WM-014 | Claude, Codex, and undetected Cursor rows remain truthful | analysis test assertions | DOMAIN | analysis step | modal tests |
| WM-015 | Account screen uses the production-authority GitHub/Google/email method set and hierarchy | Human decision 2026-08-26; production `AuthMethods` | REUSE | `AuthMethods` + OV-WM-015 | modal tests/story |
| WM-016 | Desktop may skip account; Web may not | account skip tests | DOMAIN | account step configuration | modal tests |
| WM-017 | Existing signed-in account can continue | account-created branch | DOMAIN | account step | modal test |
| WM-018 | First user creates an organization with prefilled name/slug/logo | organization test | REUSE | DS form controls in organization step | modal test/story |
| WM-019 | Name edits derive slug until the slug is edited | create organization implementation | DOMAIN | organization step | modal test |
| WM-020 | Organization URL is only rendered for a non-empty slug | organization test | DOMAIN | organization step | modal test |
| WM-021 | Existing-domain user can join or create an organization | organization test | REUSE | DS controls in chooser step | modal test/story |
| WM-022 | Sync step uses canonical full, metadata, and off values while accepting legacy insights/local snapshots | Human decision 2026-08-26; sync tests | REUSE | `DataSyncLevelPicker` + OV-WM-022 migration | modal/storage tests |
| WM-023 | Sync choice remains controlled across navigation | shell state | DOMAIN | portable dialog props + prototype store | persistence test |
| WM-024 | Download action matches the detected desktop OS | platform tests | DOMAIN | download step | modal tests/story |
| WM-025 | Web cannot skip download when the organization has no data | download tests | DOMAIN | download step configuration | modal tests |
| WM-026 | Download and skip are distinct callbacks | download test | DOMAIN | download step | modal test |
| WM-027 | Existing teammate preview only appears for established teams | invite implementation | DOMAIN | invite step | first/51st-user stories |
| WM-028 | Multi-email entry accepts comma, whitespace, semicolon, and paste | invite tests | REUSE | DS `Input`/`Chip` in invite form | invite tests |
| WM-029 | Invite entry normalizes case and removes duplicates | invite tests | DOMAIN | invite form | invite tests |
| WM-030 | Malformed addresses are linked to an announced field error | invite tests/ARIA attributes | REUSE | DS form controls in invite form | invite tests |
| WM-031 | Every recipient chip has a recipient-specific remove name | invite implementation | REUSE | DS `Chip` + button | invite test |
| WM-032 | Invite success is announced before advancing | invite implementation | DOMAIN | invite step | modal test |
| WM-033 | Invite and skip remain distinct state transitions | invite tests | DOMAIN | prototype controller | controller/modal tests |
| WM-034 | Google/email-created accounts receive the canonical required GitHub connection prompt | Human decision 2026-08-26 | REUSE | `ConnectGitHubPrompt` + OV-WM-034 | modal tests/story |
| WM-035 | GitHub connection is not skippable | Human decision 2026-08-26 | DELETE | canonical prompt | modal test/story |
| WM-036 | Completion launches the spotlight only after the modal exits | shell timers | DOMAIN | prototype host controller | shell behavior tests |
| WM-037 | Modal and spotlight never run concurrently | shell predicates | DOMAIN | prototype host controller | shell behavior tests |
| WM-038 | Incomplete optional work appears in the Getting Started card | sidebar tests | DOMAIN | existing prototype sidebar | sidebar tests |
| WM-039 | Recovery reopens the requested step and Back returns to completion | shell `openFtuePhase` | DOMAIN | prototype controller | navigation tests |
| WM-040 | Mode and first/51st-user fixtures remain independently selectable | developer menu tests | DOMAIN | prototype fixture menu | menu tests |
| WM-041 | Each mode/user fixture resumes its own wizard snapshot after reload | User-requested persistent user state | CREATE | versioned prototype storage adapter | storage tests |
| WM-042 | Persisted state has an explicit schema version | User request; storage best practice | CREATE | prototype storage adapter | parser tests |
| WM-043 | Invalid, partial, unknown-version, or unavailable storage degrades to a fresh flow without exposing the dashboard during restoration | persistence boundary contract | CREATE | prototype storage adapter + neutral restoring step | parser/hook/dialog tests |
| WM-044 | Reset and sign-out clear the current fixture snapshot | User-requested persistence control | EXTEND | developer menu + controller | menu/storage tests |
| WM-045 | Transient overlay/tour/timer/layout state is not persisted | storage minimization contract | CREATE | prototype storage adapter | serialized-shape test |
| WM-046 | The portable wizard owns no route, auth, API, storage, or timer | componentization portability contract | DOMAIN | `packages/app/onboarding` | source boundary + story |
| WM-047 | The prototype is fixture/controller composition, not a second UI stack | componentization deletion gate | DELETE | prototype adapter imports package surface | old-symbol search |
| WM-048 | Existing dashboard, sidebar, settings, annotations, and spotlight behavior is otherwise unchanged | PR #5968 tests | REUSE | existing prototype owners | existing focused suite |

## Token reconciliation

The promoted surface consumes the existing semantic color, border, radius,
type, spacing, motion, and elevation utilities already used by the approved
prototype. The hand-built `z-[49]` overlay is deleted in favor of the cataloged
Dialog overlay. No new token or design-system primitive is introduced. The
prototype-only violet handoff annotation remains in the prototype adapter and
is not promoted into `packages/app`.

## Completed deletion ledger

- Deleted the custom blocking-overlay element and `modal={false}` escape hatch.
- Replaced the 1,785-line `guided-ftue-modal.tsx` monolith with a thin prototype
  adapter over the portable package surface.
- Deleted the prototype-local auth, sync, GitHub prompt, invite form, invite
  validation, and step-layout implementations superseded by canonical owners.
- Kept fixture-only annotations, brand-image fixtures, and developer controls in
  `apps/prototypes`; none is promoted as reusable product chrome.

## Approved overrides and decisions

| Override ID | Changes | Approval | Reason and permanence | Evidence |
| --- | --- | --- | --- | --- |
| OV-WM-003 | Preserve the prototype's locked Escape/outside dismissal instead of the ordinary dismissible Dialog behavior. Focus trap and inert background still come from canonical Dialog. | User, 2026-08-26, this task | Onboarding remains blocking; persistent state protects refresh/re-entry but does not make the flow optional. Permanent until product explicitly changes the gate. | modal interaction test |
| OV-WM-005 | Preserve the prototype's exact `900px × 680px` maximum geometry rather than approximating it to the current spacing scale. Implement it once as a canonical Dialog size variant. | User, 2026-08-26, this task | Exact approved prototype geometry. Permanent reusable Dialog contract. | DS story/test + compact wizard story |
| OV-WM-015 | Replace the prototype's GitHub/Google-only chooser with production authority's GitHub/Google/email `AuthMethods`. | User, 2026-08-26, this task | Cross-surface auth parity outranks the older prototype method set. Permanent. | account step tests/story |
| OV-WM-022 | Replace prototype values `insights` and `local` with canonical `metadata` and `off`; the persistence boundary migrates the former aliases. | User, 2026-08-26, this task | One backward-compatible sync vocabulary across onboarding and Settings. Permanent migration shim for existing prototype snapshots. | sync story + legacy snapshot tests |
| OV-WM-034 | Replace the optional prototype GitHub screen/copy with the production-authority `ConnectGitHubPrompt`; remove Skip. | User, 2026-08-26, this task | One GitHub grant contract across surfaces. Permanent. | GitHub step tests/story |
| OV-WM-024 | Replace raw Apple/Windows/Linux CTA colors with the standard primary Button; retain platform icon, label, and installer target. | User, 2026-08-26, this task | The raw platform colors have no canonical token/control and are not an intentional product contract. Permanent. | platform download tests/story |

WM-041 through WM-045 are the explicit persistence behavior requested in this
task and are not fidelity exceptions.

## Completion audit

- Prototype coverage: 48 of 48 observable contracts are mapped; zero rows are
  unmapped or marked `N/A`.
- System conformance: reusable UI resolves to design-system or `packages/app`
  owners. The remaining prototype-only annotations, fixture assets, and host
  controls are deliberately excluded from the promoted surface.
- Overrides: six approved decisions are recorded above with authority, reason,
  permanence, and verification evidence.
- Token impact: no global token changes and no new primitive. The only
  design-system extension is the reusable `DialogContent` `large` size contract.
- Structural outcome: the prototype adapter is under 200 lines, the host shell is
  under 250 lines, and the portable dialog is split into responsibility-scoped
  step modules with co-located tests and Storybook stories.
- Visual verification: source, interaction tests, compact stories, and geometry
  tests are included. A live browser comparison could not run because the
  in-app browser backend was unavailable in this environment.
