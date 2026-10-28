# Decisions for data-controls-device-policy-web

## Device data policy, a composite of the shipped data-control parts
- kind: component
- by: agent
- when: first build
- why: Web needs one device's reported policy, read-only. The level, count and machine are what DataSyncPolicySummary already draws; reported vs not reported is PolicyStatusIndicator's active and unavailable states; the scope is DirectoryScopeList. The composite adds only the arrangement and the null-policy branch.
- component: DeviceDataPolicy
- path: packages/app/shared/components/device-data-policy.tsx
- call: new
- considered: extending RegisteredDesktopRow in Connected Devices (ruled out for now: it is wired to useComputeTargets and there is no per-device policy to feed it; it is the intended host once a producer exists)

## Read-only scope list as a prop on the shipped list
- kind: component
- by: agent
- when: first build
- why: A reported scope must show what the device collects without offering a toggle (AC-003). CheckboxTree's read-only lock already does this and requires a reason, so DirectoryScopeList takes one optional readOnlyReason and locks every top-level row with it; descendants inherit the lock.
- component: DirectoryScopeList
- path: packages/app/shared/components/directory-scope-list.tsx
- call: extended
- considered: omitting onIncludedIdsChange (rows still look and announce as clickable); a parallel read-only list (forbidden)

## No reported policy is the unavailable state, never the unset message
- kind: behavior
- by: agent
- when: first build
- why: DataSyncPolicySummary's unset message asks the reader to choose a level below, which web cannot offer. A device with nothing reported, unset included, renders PolicyStatusIndicator unavailable with the machine name instead (AC-002).
