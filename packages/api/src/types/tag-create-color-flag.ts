/**
 * ISS-6385 — gates the create-a-tag-then-pick-its-colour step in `TagPicker`.
 *
 * ## What flipping it ON changes on screen
 *
 * Creating a tag from the picker's "Create …" row currently applies the new tag
 * and closes the list; the colour the server picked round-robin
 * (`pickDefaultColor`, `apps/api/app/tags/service.ts`) is whatever the user
 * gets, and changing it means leaving for the tags settings tab. ON, the picker
 * stays open on the tag it just created and offers the canonical 16-swatch grid
 * for it, so naming and colouring a tag are one uninterrupted act.
 *
 * Nothing is removed either way: the tag is created and applied identically,
 * and the colour is still changeable from settings.
 *
 * OFF is the default, per the ISS-4779 closed-by-default UI policy.
 *
 * ## Both platforms, because the surface exists on both
 *
 * Web reads this as a PostHog flag via `TAG_CREATE_COLOR_FEATURE_FLAG_KEY`
 * (`packages/app/shared/lib/feature-flags.ts`); the desktop renderer resolves
 * the byte-identical key from the signed-in account's PostHog assignment,
 * delivered over the IPC bridge, under the alias
 * `DESKTOP_TAG_CREATE_COLOR_FEATURE_FLAG_KEY`
 * (`apps/desktop/src/shared/feature-flags-labs-surfaces.ts`), default OFF.
 *
 * `TagPicker` reaches the desktop renderer through a RENDER path, not an
 * import: `BranchesView` renders `BranchesListSurfaceV2`, whose grid tag cell
 * renders `EntityTagsCell`, which renders `TagPicker` with tag creation when
 * the row allows applying tags. Grepping
 * `apps/desktop/src` for `tag-picker` finds nothing and is the wrong question —
 * it is what the renderer MOUNTS that decides parity. Both halves alias this one
 * constant so a rename cannot light the step on one surface while hiding it on
 * the other.
 *
 * Lives in `@repo/api` rather than beside the web flag map for the same reason
 * its siblings do: one literal, so a rename cannot leave two spellings behind.
 */
export const TAG_CREATE_COLOR_FLAG_KEY = "tag-create-color" as const;
