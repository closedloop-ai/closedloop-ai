/**
 * ISS-6679: the "New Pack" dialog — the entry point of the entire pack-authoring
 * funnel — had ZERO tests. One commit ever (`76d80dc0a`, FEA-2923 PR2) and never
 * touched since, so nothing anywhere proved it still works.
 *
 * THE FALSE GREEN THIS FILE IS BUILT AGAINST. `handleCreate`
 * (`create-pack-dialog.tsx:58-79`) sets `created` on success and leaves the
 * dialog OPEN; on failure it sets `formError` and also leaves it open. Neither
 * path calls `onOpenChange(false)`. So a test keyed on the dialog closing would
 * never pass on success and would pass on the error path for the wrong reason.
 * Every test here pins what the dialog actually became — the created-state copy
 * and its upload affordances, or the inline error beside a still-editable form —
 * and pins `onOpenChange` as NOT called, which is the fact those two states
 * share and the one a "did it close?" assertion gets backwards.
 *
 * THE VALIDATION HALF IS ABOUT THE NETWORK, NOT THE MESSAGE. "Empty name shows
 * an error" is satisfied by a dialog that shows the message AND posts anyway.
 * The load-bearing assertion is that the create mutation — the module boundary
 * `POST /catalog` goes through — was never invoked. It is captured on the mock
 * and asserted from the test body after the click, never inside a handler that
 * might not run.
 *
 * SCOPE, STATED HONESTLY. ISS-6679 asks for this as an e2e driven through the
 * "New Pack" button. That button renders only under `isAdmin`
 * (`catalog-dashboard.tsx:349-354`), which on `/packs` is chosen SERVER-side by
 * `has({ role: "org:admin" })` (`packs/page.tsx:47`) — a decision no route mock
 * can move and that the e2e suite cannot pin or verify (the ISS-5119 role
 * persona is landed but inert; `e2e/SECOND-PERSONA.md`). That is ISS-6679's own
 * "BLOCKED ON ISS-6096" note, confirmed on this branch. This file covers the
 * dialog's whole contract at the level where it IS reachable and deterministic;
 * the button-to-dialog step remains uncovered and is reported on the ticket.
 *
 * The two halves this file deliberately does not restate: `useCreateCatalogItem`
 * really POSTs `/catalog` and really invalidates `catalogKeys.lists()` — which
 * is the entire mechanism by which a created pack appears in the catalog list —
 * is covered by `packages/app/agents/hooks/__tests__/use-catalog.test.tsx:119-142`.
 */
import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import {
  CatalogItemScope,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreatePackDialog } from "../create-pack-dialog";

const mocks = vi.hoisted(() => ({
  createCatalogItem: vi.fn(),
  uploadIntent: vi.fn(),
  confirmUpload: vi.fn(),
}));

// The created-state renders two `CatalogItemUpload`s, which pull their own
// mutations from this same module — so one mock covers the dialog and the
// affordances it reveals.
vi.mock("@repo/app/agents/hooks/use-catalog", () => ({
  useCreateCatalogItem: () => ({
    isPending: false,
    mutateAsync: mocks.createCatalogItem,
  }),
  useUploadIntent: () => ({
    isPending: false,
    mutateAsync: mocks.uploadIntent,
  }),
  useConfirmUpload: () => ({
    isPending: false,
    mutateAsync: mocks.confirmUpload,
  }),
}));

// `CreateCatalogItemRequest.targetKind` is typed as a bare `string`
// (`packages/api/src/types/distribution.ts:380`) with no const to import, so the
// contract value the Pack container is created under is named once here rather
// than repeated at each assertion.
const PACK_TARGET_KIND = "pack";

const REQUIRED_NAME_ERROR = "Name is required.";
/** `create-pack-dialog.tsx:76` — the copy for a rejection that is not an `Error`. */
const GENERIC_CREATE_ERROR = "Failed to create Pack.";
const CREATE_BUTTON = "Create Pack";
const DONE_BUTTON = "Done";
// The created state's two upload affordances, named the way a user reaches them
// — `CatalogItemUpload` renders each as a `Button` labelled `Upload ${label}`
// over a visually-hidden file input, so the accessible button name is the
// affordance. Asserting the bare label text would also match that input's
// `aria-label`, which is present in every step including the ones with no
// clickable control.
const ZIP_UPLOAD_BUTTON = "Upload Plugin bundle (.zip)";
const LOGO_UPLOAD_BUTTON = "Upload Logo image";
const RE_NAME_FIELD = /^Name/;
const DESCRIPTION_FIELD = "Description";
const RE_CREATED_CONFIRMATION = /^Created/;

// Spelled in full rather than cast: the dialog hands this object straight to
// `onCreated`, whose caller (`catalog-dashboard.tsx:303`) selects the pack by
// `id`, so a field the DTO gains must fail typecheck here rather than be papered
// over by an `as`.
const CREATED_PACK: CatalogItemDto = {
  agentSlug: null,
  archived: false,
  coaching: false,
  coachingConfig: null,
  components: [],
  content: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdById: "user-1",
  description: "Org-wide standards",
  enabled: true,
  id: "pack-created-1",
  logoUrl: null,
  name: "Platform Standards",
  organizationId: "org-1",
  parentPackId: null,
  scope: CatalogItemScope.Org,
  sortOrder: 0,
  source: CatalogItemSource.OrgCustom,
  targetKind: PACK_TARGET_KIND,
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: "1.0.0",
};

function renderDialog(overrides?: {
  onCreated?: (pack: CatalogItemDto) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const onCreated = overrides?.onCreated ?? vi.fn();
  const onOpenChange = overrides?.onOpenChange ?? vi.fn();
  render(
    <CreatePackDialog onCreated={onCreated} onOpenChange={onOpenChange} open />
  );
  return { onCreated, onOpenChange };
}

function fillForm(input: { name: string; description?: string }) {
  fireEvent.change(screen.getByLabelText(RE_NAME_FIELD), {
    target: { value: input.name },
  });
  if (input.description !== undefined) {
    fireEvent.change(screen.getByLabelText(DESCRIPTION_FIELD), {
      target: { value: input.description },
    });
  }
}

describe("CreatePackDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCatalogItem.mockResolvedValue(CREATED_PACK);
  });

  it("refuses an empty name without ever issuing the create request", async () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: CREATE_BUTTON }));

    await screen.findByText(REQUIRED_NAME_ERROR);
    // The assertion the message alone cannot make: a dialog that complained AND
    // posted anyway would satisfy the line above and fail this one.
    expect(mocks.createCatalogItem).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    // Still the form, not the created state — the refusal did not advance.
    expect(screen.getByRole("button", { name: CREATE_BUTTON })).toBeDefined();
  });

  it("treats a whitespace-only name as empty and still issues nothing", async () => {
    renderDialog();

    fillForm({ name: "   " });
    fireEvent.click(screen.getByRole("button", { name: CREATE_BUTTON }));

    await screen.findByText(REQUIRED_NAME_ERROR);
    expect(mocks.createCatalogItem).not.toHaveBeenCalled();
  });

  it("creates the Pack container and reveals its upload affordances", async () => {
    const { onCreated, onOpenChange } = renderDialog();

    fillForm({
      name: "  Platform Standards  ",
      description: "  Org-wide standards  ",
    });
    fireEvent.click(screen.getByRole("button", { name: CREATE_BUTTON }));

    await waitFor(() => expect(mocks.createCatalogItem).toHaveBeenCalled());
    // The wire shape, not merely "it was called": `targetKind` is what makes the
    // new row a Pack CONTAINER rather than a standalone component, and both
    // free-text fields are trimmed before they are sent.
    expect(mocks.createCatalogItem).toHaveBeenCalledWith({
      coaching: undefined,
      description: "Org-wide standards",
      name: "Platform Standards",
      targetKind: PACK_TARGET_KIND,
    });

    // The created state, which is what the dialog becomes instead of closing.
    expect(await screen.findByText(RE_CREATED_CONFIRMATION)).toBeDefined();
    expect(
      screen.getByRole("button", { name: ZIP_UPLOAD_BUTTON })
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: LOGO_UPLOAD_BUTTON })
    ).toBeDefined();
    expect(screen.getByRole("button", { name: DONE_BUTTON })).toBeDefined();
    // And the form it replaced is gone, so "created" is a real transition rather
    // than a message appended beneath a still-submittable form.
    expect(screen.queryByRole("button", { name: CREATE_BUTTON })).toBeNull();

    // The caller is handed the created pack so it can open it to add components
    // (`catalog-dashboard.tsx:303` selects it), and the dialog stays open.
    expect(onCreated).toHaveBeenCalledWith(CREATED_PACK);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("omits an empty description rather than sending a blank string", async () => {
    renderDialog();

    fillForm({ name: "Platform Standards", description: "   " });
    fireEvent.click(screen.getByRole("button", { name: CREATE_BUTTON }));

    await waitFor(() => expect(mocks.createCatalogItem).toHaveBeenCalled());
    expect(mocks.createCatalogItem).toHaveBeenCalledWith({
      coaching: undefined,
      description: undefined,
      name: "Platform Standards",
      targetKind: PACK_TARGET_KIND,
    });
  });

  it("keeps the dialog open on a refused create and states the refusal inline", async () => {
    const forbidden = new Error("You do not have permission to create packs.");
    mocks.createCatalogItem.mockRejectedValue(forbidden);
    const { onCreated, onOpenChange } = renderDialog();

    fillForm({ name: "Platform Standards" });
    fireEvent.click(screen.getByRole("button", { name: CREATE_BUTTON }));

    expect(await screen.findByText(forbidden.message)).toBeDefined();
    // The dialog did NOT advance to the created state — the distinction a
    // "still open" assertion on its own cannot make, because BOTH outcomes leave
    // it open.
    expect(screen.queryByText(RE_CREATED_CONFIRMATION)).toBeNull();
    expect(
      screen.queryByRole("button", { name: ZIP_UPLOAD_BUTTON })
    ).toBeNull();
    // The form is still there and still submittable, so the admin can retry.
    expect(screen.getByRole("button", { name: CREATE_BUTTON })).toBeDefined();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("clears a prior refusal as soon as the retry is in flight", async () => {
    const forbidden = new Error("You do not have permission to create packs.");
    let settleRetry: (pack: CatalogItemDto) => void = () => {
      // Replaced synchronously by the deferred implementation below.
    };
    mocks.createCatalogItem.mockRejectedValueOnce(forbidden);
    mocks.createCatalogItem.mockImplementationOnce(
      () =>
        new Promise<CatalogItemDto>((resolve) => {
          settleRetry = resolve;
        })
    );
    renderDialog();

    fillForm({ name: "Platform Standards" });
    fireEvent.click(screen.getByRole("button", { name: CREATE_BUTTON }));
    expect(await screen.findByText(forbidden.message)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: CREATE_BUTTON }));

    // The retry is deliberately left UNSETTLED here. `handleCreate`'s
    // `setFormError(null)` (`create-pack-dialog.tsx:59`) is only observable in
    // this window: once the create resolves, `created` swaps the whole `!created`
    // branch — `formError`'s only render site — off screen, so asserting the
    // stale message is gone AFTER success passes whether or not that line ran.
    await waitFor(() =>
      expect(screen.queryByText(forbidden.message)).toBeNull()
    );
    // And this is still the in-flight form, not the created state — without it
    // the assertion above could be satisfied by the very branch swap it exists
    // to avoid depending on.
    expect(screen.getByRole("button", { name: CREATE_BUTTON })).toBeDefined();
    expect(screen.queryByText(RE_CREATED_CONFIRMATION)).toBeNull();

    settleRetry(CREATED_PACK);
    expect(await screen.findByText(RE_CREATED_CONFIRMATION)).toBeDefined();
  });

  it("states a generic refusal when the rejection is not an Error", async () => {
    // `mutateAsync` rejects with whatever crossed the transport, and nothing
    // types that as an `Error` — a string or a plain object reaches this branch
    // at runtime, so the fallback copy is reachable, not type-forbidden.
    mocks.createCatalogItem.mockRejectedValue({ status: 403 });
    renderDialog();

    fillForm({ name: "Platform Standards" });
    fireEvent.click(screen.getByRole("button", { name: CREATE_BUTTON }));

    expect(await screen.findByText(GENERIC_CREATE_ERROR)).toBeDefined();
    expect(screen.queryByText(RE_CREATED_CONFIRMATION)).toBeNull();
  });

  it("closes and resets only when the admin dismisses the created state", async () => {
    const { onOpenChange } = renderDialog();

    fillForm({ name: "Platform Standards" });
    fireEvent.click(screen.getByRole("button", { name: CREATE_BUTTON }));
    expect(await screen.findByText(RE_CREATED_CONFIRMATION)).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: DONE_BUTTON }));

    // "Done" is the ONLY path in this component that closes the dialog
    // (`create-pack-dialog.tsx:169-177`) — neither a successful create nor a
    // refused one calls `onOpenChange`. Untested, the dialog's sole affirmative
    // close could be removed with every other test here still green.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // And it reset on the way out. Without `reset()`, reopening would land the
    // admin back on the PREVIOUS pack's created state — offering uploads for a
    // pack they are no longer creating.
    expect(screen.queryByText(RE_CREATED_CONFIRMATION)).toBeNull();
    expect(screen.getByRole("button", { name: CREATE_BUTTON })).toBeDefined();
    expect(screen.getByLabelText(RE_NAME_FIELD)).toHaveValue("");
  });
});
