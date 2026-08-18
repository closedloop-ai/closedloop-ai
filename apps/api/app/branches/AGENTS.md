# apps/api/app/branches — branch read + analytics

Serves the Branch list/detail the web shell and desktop both render. The desktop projects the same records locally (`apps/desktop/src/main/branch/`), so divergence here becomes "the same Branch tells two stories". App-wide rules: `apps/api/AGENTS.md`.

## Enrichment must not be fatal

An optional analytics read on a required path takes the whole surface down when it times out. Keep lifetime/usage enrichment in a best-effort failure domain: return the rows, omit the field or mark analytics unavailable, and match the desktop page-data behavior. Never let a Value-per-$ column reject the branch list.

## Identity and labels

- Resolve a person's display label **once** for the surface. Projecting `displayName ?? login` in the header while session rows are stamped from `displayUserName` puts the same human on one screen under two names.
- A projector that never populates `displayName` makes that fallback a silent downgrade to a login. Either resolve the display name from the same org-scoped lookup already being made, or accept the login and make every row on the surface agree.
- Distinguish "no owner" from "owner unavailable" and carry the distinction to the render.

## Cohort and window consistency

When the canonical cohort is deliberately reloaded without date predicates, every input projected onto it must be loaded for that same cohort. Supplying date-filtered usage to an unfiltered canonical row set undercounts spend and makes comparisons spuriously unavailable — load usage for the canonical row IDs before projecting.

## Completeness claims

Derive completeness from per-source, per-channel acquisition state, not from "at least one fetch for this entity succeeded". When comment families are acquired independently, a PR with one successful channel and one failed/capped channel is reported complete while its author set is missing; conversely a successful fetch yielding zero rows creates no projection and looks incomplete. Track acquisition per channel.

## Multi-PR branches

Single-PR math does not generalize. A branch can carry several PRs and several sessions — check that counts, status derivations, and cost attribution reconcile against the branch's full population, not the first PR.
