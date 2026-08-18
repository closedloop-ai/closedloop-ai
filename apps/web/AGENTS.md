# apps/web — marketing site + `/docs` (:3001)

No navigation provider here: `apps/web` keeps `next/link` (unlike `apps/app` / `packages/app`, which use `@repo/navigation/link`).

`content/docs/**` is the **public contract**. Review feedback here is almost entirely one defect class: the docs assert a stronger guarantee than the implementation makes.

## A claim must cite the code path that enforces it

Before writing or editing any claim about privacy, egress, identity, lifecycle, or an API shape, read the implementing code and scope the sentence to what it actually guarantees.

- **Scope to the lane, not the product.** "X no longer crosses to the cloud" is usually true of one lane and false of another (metadata lane vs. archive upload path). Name the lane.
- **State the conditions.** Egress typically depends on org policy *and* device consent, and redaction is usually pattern-scoped (secrets), not content-scoped. "Raw source stays local; a pattern-redacted copy is archived only when full sync is enabled" is the honest form. Unconditional phrasing lets a reader conclude every raw record reaches the cloud.
- **Do not collapse layers the code keeps separate.** Where identity has multiple keys (grouping key, normalized fingerprint, content hash), document each layer; merging them implies merges the system does not perform.
- **Scope UI-only statements to the UI.** A claim true of a UI facet menu is often false of the MCP/API contract, which may accept synthetic or alias values the UI hides.

## Docs ride with the behavior change

A PR changing egress, identity, lifecycle, or a public API shape updates the describing `content/docs/**` page in the same PR.

## `api-reference/openapi.json`

Generated-client contract — shape errors compile into other people's code.

- Model request bodies as discriminated branches when the runtime validates field *pairs*. A flat field-level union lets clients compile combinations the endpoint always rejects.
- Public input aliases the runtime accepts must appear in the schema even when they normalize to another value internally.

## Related

`docs/` = internal runbooks (unpublished). `packages/api/AGENTS.md` = the wire types these docs describe.
