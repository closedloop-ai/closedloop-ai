# Teams and Projects authorization

ISS-12644 records the existing authority used by the Teams and Projects rollout.
The rollout reuses Clerk organization membership and the existing guards; it
does not provision custom Clerk roles or migrate team membership records.

| Operation | Authentication | Existing authorization owner |
|---|---|---|
| List/read teams, team roster, repository pool | `withAnyAuth` | Authenticated organization scope in the route/service |
| Create team | Clerk session | Current organization member; `createWithOwner` records the existing creator membership |
| Rename team, add/update/remove team member, change repository pool/defaults | Clerk session | `requireTeamRole(..., TeamRole.Admin)` after organization existence check |
| Delete team | Clerk session | `requireTeamRole(..., TeamRole.Owner)` after organization existence check |
| Remove a team's last owner | Clerk session | Existing member-removal route refuses removal |
| Read/create/update/delete projects, favorites, project tree and existing artifact ranking | `withAnyAuth` | Organization-scoped project/artifact lookup and the operation's own validation |
| Read explicitly team-scoped session/analytics data | Route's existing auth wrapper | `authorizeTeamScopeRead`: same-organization team member, otherwise canonical Clerk organization-admin fallback |
| Write artifact fields | Owning artifact route | Existing organization scope, mutation capability and source authority; project owner/collaborator is not an administrative grant |

## Role compatibility

Clerk `org:member` is ordinary organization membership. The existing
`isOrgAdminRole` helper recognizes `org:admin` and the historical `org:owner` as
admin-equivalent; unknown or absent provider roles do not gain that fallback.
A Clerk provider failure is unresolved, rather than a false permission denial.
Existing team members do not need that fallback to read their team's scoped data.

The persisted `TeamRole.Member`, `TeamRole.Admin` and `TeamRole.Owner` values
remain accepted by existing team endpoints. Legacy Owner satisfies the existing
Admin floor as well as the deletion floor. Displaying a legacy role through
member/admin product constructs does not rewrite the record or grant a new
server capability.

Clerk organization administration is **not** currently an override in
`requireTeamRole`. The rollout preserves that distinction: it neither revokes
existing team-role holders nor silently grants organization-wide team writes.
Changing those write floors or migrating legacy membership authority requires
an explicit product decision before modifying the guards.

## Boundary evidence

- `require-team-role.test.ts`: organization lookup precedes role checks;
  missing/cross-organization teams return 404, visible denied writes return 403,
  and a team deleted during authorization still returns 404.
- `__tests__/service-org-scoping.test.ts`: actual service predicates enforce
  tenant boundaries and the legacy role hierarchy.
- `../../lib/__tests__/team-scope-policy.test.ts`: the real org-admin fallback,
  over a stubbed Clerk role provider, resolves member/admin/legacy owner,
  missing/unknown role, provider failure, membership short-circuit and
  cross-organization requests.
- `team-write-guard.integration.test.ts` (AC-004): the team rename, add-member
  and delete routes run their real guard and service against a real database
  as admin, legacy owner, member, team nonmember, removed member and
  cross-organization caller, and under a role-provider failure; every refusal
  asserts no write. The same rows drive `authorizeTeamScopeRead`.
- `../../__tests__/api/teams-route-auth.test.ts`: API-key reads remain supported;
  creation remains session-only.

All additive project contracts retain existing authentication support and
optional-field omission. Team assignment must continue to name at least one
same-organization team; this rollout does not alter multi-team project membership
or repository inheritance.
