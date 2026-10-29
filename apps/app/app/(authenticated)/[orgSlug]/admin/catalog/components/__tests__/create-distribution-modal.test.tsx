/**
 * ISS-6696: the modal that decides WHICH MACHINES receive a pack.
 *
 * These specs run through the real `useCreateDistribution` → `useApiClient`
 * path with an injected transport (the sanctioned `ApiAdapter.fetch` seam, same
 * fixture shape as `packages/app/users/hooks/__tests__/use-users.test.tsx`) and
 * assert the parsed HTTP request BODY. That matters for one case in particular:
 * `all` targeting must OMIT `targetComputeTargetIds`, not send `[]`. In-process
 * the field is present-but-`undefined`, so a spec that stopped at the mutation
 * argument could not tell omission from an empty array — only the serialized
 * body can, and downstream an `[]` is not the same request as no field at all.
 *
 * "No POST" is likewise asserted from captured requests, never inferred from
 * the modal staying open: `handleSubmit` calls `onOpenChange(false)` only on
 * success, so a closure-keyed spec cannot distinguish "validation blocked it"
 * from "the mutation was never wired".
 */

import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
  type DistributionDto,
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import type {
  AuthAdapter,
  AuthSnapshot,
} from "@repo/app/shared/auth/auth-adapter";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CreateDistributionModal } from "../create-distribution-modal";

const API_ORIGIN = "http://api.test";
const DISTRIBUTIONS_PATH = "/distributions";
const CATALOG_ITEM_ID = "pack-1";

const CREATE_FAILURE_MESSAGE =
  "Compute target compute-target-x is not in this org.";
const BLANK_TARGETS_ERROR =
  "Enter at least one compute target ID when using specific targeting.";

const RE_CREATE_BUTTON = /^Create Distribution$/;
const RE_CREATING = /^Creating…$/;
const RE_CANCEL = /^Cancel$/;
const RE_OPEN_MODAL = /^Open distribution modal$/;
const RE_TARGETING_ALL = /All compute targets/;
const RE_TARGETING_SPECIFIC = /Specific targets/;
const RE_MODE_OPT_IN = /Opt-in/;
const RE_MODE_AUTO = /Auto-install/;
const RE_TARGET_IDS_FIELD = /Compute target IDs/;

const catalogItem: CatalogItemDto = {
  id: CATALOG_ITEM_ID,
  organizationId: "org-1",
  targetKind: "pack",
  source: CatalogItemSource.OrgCustom,
  scope: CatalogItemScope.Org,
  name: "Custom Pack",
  description: "Custom description",
  version: "1.0.0",
  sortOrder: 0,
  enabled: true,
  archived: false,
  coaching: false,
  coachingConfig: null,
  parentPackId: null,
  componentUuid: null,
  content: null,
  components: [],
  agentSlug: null,
  logoUrl: null,
  createdById: "owner-1",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const createdDistribution: DistributionDto = {
  id: "distribution-1",
  organizationId: "org-1",
  catalogItemId: CATALOG_ITEM_ID,
  catalogItem: {
    id: CATALOG_ITEM_ID,
    name: "Custom Pack",
    targetKind: "pack",
    source: CatalogItemSource.OrgCustom,
  },
  mode: DistributionMode.AutoInstall,
  targetingType: DistributionTargetingType.All,
  desiredEnabled: true,
  targetingEntries: [],
  targetStatuses: [],
  assetDownloadUrl: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const loadedSnapshot: AuthSnapshot = {
  isLoaded: true,
  userId: "user-1",
  orgId: "org-1",
  getToken: () => Promise.resolve("test-token"),
};

const authAdapter: AuthAdapter = {
  useAuthSnapshot: () => loadedSnapshot,
};

type CapturedRequest = {
  method: string;
  body: Record<string, unknown>;
};

type Transport = {
  adapter: ApiAdapter;
  /** Every POST /distributions request, parsed from its serialized body. */
  createRequests: () => CapturedRequest[];
  /** Make the next create respond 400 with an error envelope. */
  failNextCreate: () => void;
  /** Hold the next create open; the returned callback releases it. */
  holdNextCreate: () => () => void;
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function createdResponse(): Response {
  return new Response(
    JSON.stringify({ success: true, data: createdDistribution }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

function makeTransport(): Transport {
  const captured: CapturedRequest[] = [];
  let failNext = false;
  let holdNext = false;
  let releaseHeld: (() => void) | null = null;

  const fetchImpl: typeof fetch = (input, init) => {
    const path = new URL(requestUrl(input), API_ORIGIN).pathname;
    if (path !== DISTRIBUTIONS_PATH) {
      // Any other request is a real defect, not a passing create.
      return Promise.reject(new Error(`unexpected request to ${path}`));
    }

    captured.push({
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });

    if (failNext) {
      failNext = false;
      return Promise.resolve(
        new Response(
          JSON.stringify({ success: false, error: CREATE_FAILURE_MESSAGE }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
      );
    }
    if (holdNext) {
      holdNext = false;
      return new Promise<Response>((resolve) => {
        releaseHeld = () => resolve(createdResponse());
      });
    }
    return Promise.resolve(createdResponse());
  };

  return {
    adapter: { resolveApiOrigin: () => API_ORIGIN, fetch: fetchImpl },
    createRequests: () => [...captured],
    failNextCreate: () => {
      failNext = true;
    },
    holdNextCreate: () => {
      holdNext = true;
      return () => releaseHeld?.();
    },
  };
}

function Providers({
  transport,
  children,
}: {
  transport: Transport;
  children: ReactNode;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: { retry: false },
          queries: { retry: false },
        },
      })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider adapter={authAdapter}>
        <ApiAdapterProvider adapter={transport.adapter}>
          {children}
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

type HarnessProps = {
  transport: Transport;
  onSuccess?: (distribution: DistributionDto) => void;
  onOpenChangeSpy?: (open: boolean) => void;
};

/**
 * Mirrors CatalogDashboard: the modal stays mounted and its `open` prop is
 * driven by parent state, so the form state it holds outlives a close unless
 * the close path resets it.
 */
function Harness({ transport, onSuccess, onOpenChangeSpy }: HarnessProps) {
  const [open, setOpen] = useState(false);
  return (
    <Providers transport={transport}>
      <button onClick={() => setOpen(true)} type="button">
        Open distribution modal
      </button>
      <CreateDistributionModal
        catalogItem={catalogItem}
        onOpenChange={(next) => {
          onOpenChangeSpy?.(next);
          setOpen(next);
        }}
        onSuccess={onSuccess}
        open={open}
      />
    </Providers>
  );
}

function openModal(): void {
  fireEvent.click(screen.getByRole("button", { name: RE_OPEN_MODAL }));
}

function chooseSpecificTargeting(): void {
  fireEvent.click(screen.getByRole("radio", { name: RE_TARGETING_SPECIFIC }));
}

function typeTargets(value: string): void {
  fireEvent.change(screen.getByLabelText(RE_TARGET_IDS_FIELD), {
    target: { value },
  });
}

function submit(): void {
  fireEvent.click(screen.getByRole("button", { name: RE_CREATE_BUTTON }));
}

/**
 * Explicit, not inherited: mounting the Radix dialog tree in jsdom costs ~2s
 * per case here and the first case additionally pays first-mount cost, which
 * sits right on vitest's 5s default. Nothing in this suite waits on elapsed
 * time — every assertion resolves on a rendered node or a captured request — so
 * the ceiling bounds a genuine hang rather than masking one.
 */
const SUITE_TIMEOUT_MS = 30_000;

describe(
  "CreateDistributionModal",
  () => {
    it("blocks a blank specific-targeting submit and issues no request", async () => {
      const transport = makeTransport();
      const onOpenChangeSpy = vi.fn();
      render(
        <Harness onOpenChangeSpy={onOpenChangeSpy} transport={transport} />
      );
      openModal();
      chooseSpecificTargeting();

      submit();

      expect(await screen.findByText(BLANK_TARGETS_ERROR)).toBeInTheDocument();
      expect(transport.createRequests()).toHaveLength(0);
      expect(onOpenChangeSpy).not.toHaveBeenCalled();
    });

    it("blocks a whitespace-only specific-targeting submit and issues no request", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();
      chooseSpecificTargeting();
      typeTargets("   \n\t\n  ");

      submit();

      expect(await screen.findByText(BLANK_TARGETS_ERROR)).toBeInTheDocument();
      expect(transport.createRequests()).toHaveLength(0);
    });

    it("splits, trims and drops empty lines from the textarea into targetComputeTargetIds", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();
      chooseSpecificTargeting();
      typeTargets("  target-a  \n\n target-b\n   \ntarget-c ");

      submit();

      await waitFor(() => expect(transport.createRequests()).toHaveLength(1));
      expect(transport.createRequests()[0].body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.Specific,
        desiredEnabled: true,
        targetComputeTargetIds: ["target-a", "target-b", "target-c"],
      });
    });

    // The sharp one. `[]` and "field absent" are different wire payloads, and an
    // empty array can read downstream as "target nothing" — the opposite of what
    // "All compute targets" means. Asserted on the serialized body, where the two
    // are actually distinguishable.
    it("omits targetComputeTargetIds entirely on `all` targeting", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();

      submit();

      await waitFor(() => expect(transport.createRequests()).toHaveLength(1));
      const request = transport.createRequests()[0];
      expect(request.method).toBe("POST");
      expect(request.body).not.toHaveProperty("targetComputeTargetIds");
      expect(request.body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
      });
    });

    // The case above submits the PRISTINE default-All state, where
    // `specificTargets` has never been written — so it stays green even if the
    // body serialized `specificTargets` unconditionally, ignoring
    // `targetingType`. This one dirties that state first and then leaves
    // Specific, which is the only arrangement where the two implementations
    // disagree: an org-wide distribution that silently carries the stale IDs
    // would target only those, the opposite of "All compute targets".
    it("omits targetComputeTargetIds after Specific targets are entered and then abandoned for `all`", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();
      chooseSpecificTargeting();
      typeTargets("stale-target-a\nstale-target-b");
      fireEvent.click(screen.getByRole("radio", { name: RE_TARGETING_ALL }));

      submit();

      await waitFor(() => expect(transport.createRequests()).toHaveLength(1));
      const request = transport.createRequests()[0];
      expect(request.body).not.toHaveProperty("targetComputeTargetIds");
      expect(request.body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
      });
      // The serialized body is the contract, but assert the stale values are
      // absent from the whole payload too: a future field carrying them would
      // reintroduce the leak under a different key.
      expect(JSON.stringify(request.body)).not.toContain("stale-target-a");
    });

    it("sends desiredEnabled true alongside the opt-in mode", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();
      fireEvent.click(screen.getByRole("radio", { name: RE_MODE_OPT_IN }));

      submit();

      await waitFor(() => expect(transport.createRequests()).toHaveLength(1));
      expect(transport.createRequests()[0].body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.OptIn,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
      });
    });

    it("hands the created distribution to onSuccess and closes on success", async () => {
      const transport = makeTransport();
      const onSuccess = vi.fn();
      const onOpenChangeSpy = vi.fn();
      render(
        <Harness
          onOpenChangeSpy={onOpenChangeSpy}
          onSuccess={onSuccess}
          transport={transport}
        />
      );
      openModal();

      submit();

      await waitFor(() =>
        expect(onSuccess).toHaveBeenCalledWith(
          expect.objectContaining({ id: createdDistribution.id })
        )
      );
      expect(onOpenChangeSpy).toHaveBeenCalledWith(false);
    });

    // The success path closes by calling the `onOpenChange` PROP directly
    // (`:99`), bypassing `handleOpenChange` and therefore its reset — so it
    // owns its own `resetForm()` (`:100`) and needs its own coverage. Without
    // this case, deleting that line ships an admin a second distribution
    // pre-filled with the first one's mode, targeting and target IDs.
    it("resets after a SUCCESSFUL create, so the next submit does not inherit the previous distribution", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();
      fireEvent.click(screen.getByRole("radio", { name: RE_MODE_OPT_IN }));
      chooseSpecificTargeting();
      typeTargets("target-a");

      submit();
      await waitFor(() => expect(transport.createRequests()).toHaveLength(1));
      expect(transport.createRequests()[0].body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.OptIn,
        targetingType: DistributionTargetingType.Specific,
        desiredEnabled: true,
        targetComputeTargetIds: ["target-a"],
      });

      openModal();
      submit();

      await waitFor(() => expect(transport.createRequests()).toHaveLength(2));
      expect(transport.createRequests()[1].body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
      });
    });

    // `disabled` and the label are two separate bindings off the same
    // `isPending` (`:244`, `:251`, `:254`). Reading only the label would pass
    // with the `disabled` guard dropped, and a second click on a modal that
    // decides which machines receive a pack is a second org-wide roll-out. So
    // this holds the create open, clicks again, and counts REQUESTS.
    it("disables both footer buttons while the create is in flight, so a second click cannot fire a second roll-out", async () => {
      const transport = makeTransport();
      const release = transport.holdNextCreate();
      const onOpenChangeSpy = vi.fn();
      render(
        <Harness onOpenChangeSpy={onOpenChangeSpy} transport={transport} />
      );
      openModal();

      submit();

      const pending = await screen.findByRole("button", { name: RE_CREATING });
      expect(pending).toBeDisabled();
      expect(screen.getByRole("button", { name: RE_CANCEL })).toBeDisabled();

      fireEvent.click(pending);
      expect(transport.createRequests()).toHaveLength(1);

      release();

      await waitFor(() => expect(onOpenChangeSpy).toHaveBeenCalledWith(false));
      expect(transport.createRequests()).toHaveLength(1);
    });

    it("keeps the modal open and shows the failure message when the create is rejected", async () => {
      const transport = makeTransport();
      const onSuccess = vi.fn();
      const onOpenChangeSpy = vi.fn();
      transport.failNextCreate();
      render(
        <Harness
          onOpenChangeSpy={onOpenChangeSpy}
          onSuccess={onSuccess}
          transport={transport}
        />
      );
      openModal();

      submit();

      expect(
        await screen.findByText(CREATE_FAILURE_MESSAGE)
      ).toBeInTheDocument();
      expect(transport.createRequests()).toHaveLength(1);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onOpenChangeSpy).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: RE_CREATE_BUTTON })
      ).toBeInTheDocument();
    });

    // The reset is asserted on the NEXT request's payload, not only on which
    // radio looks checked: the component outlives the close, so unreset state
    // would be silently re-submitted.
    it("resets mode and targeting after a close, so the next submit is auto-install/all", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();
      fireEvent.click(screen.getByRole("radio", { name: RE_MODE_OPT_IN }));
      chooseSpecificTargeting();
      typeTargets("target-a");

      fireEvent.click(screen.getByRole("button", { name: RE_CANCEL }));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: RE_CREATE_BUTTON })
        ).not.toBeInTheDocument()
      );

      openModal();
      expect(
        await screen.findByRole("radio", { name: RE_TARGETING_ALL })
      ).toBeChecked();
      expect(screen.getByRole("radio", { name: RE_MODE_AUTO })).toBeChecked();
      expect(
        screen.getByRole("radio", { name: RE_MODE_OPT_IN })
      ).not.toBeChecked();
      expect(
        screen.queryByLabelText(RE_TARGET_IDS_FIELD)
      ).not.toBeInTheDocument();

      submit();

      await waitFor(() => expect(transport.createRequests()).toHaveLength(1));
      expect(transport.createRequests()[0].body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
      });
    });

    // ISS-7004. The blank-submit error is scoped to `specific` targeting by its
    // own wording, but the state holding it used to survive until the next
    // submit or a close — so switching back to "All compute targets" left the
    // modal demanding compute target IDs it no longer has a field for. The
    // modal is asserted still OPEN and still on the pristine `all` payload,
    // because "the text is gone" is also true of an unmounted modal.
    it("clears the specific-targeting error when targeting switches back to `all`", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();
      chooseSpecificTargeting();

      submit();
      expect(await screen.findByText(BLANK_TARGETS_ERROR)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("radio", { name: RE_TARGETING_ALL }));

      await waitFor(() =>
        expect(screen.queryByText(BLANK_TARGETS_ERROR)).not.toBeInTheDocument()
      );
      expect(
        screen.getByRole("button", { name: RE_CREATE_BUTTON })
      ).toBeInTheDocument();
      expect(transport.createRequests()).toHaveLength(0);

      submit();

      await waitFor(() => expect(transport.createRequests()).toHaveLength(1));
      expect(transport.createRequests()[0].body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
      });
    });

    // ISS-7206 asked whether the Mode radio reaches the same staleness class
    // the case above fixes. It does not, and this case is why: the message
    // names `specific` targeting and an empty target list, and a Mode click
    // moves neither. So it replaces ISS-7004's "the error survives a Mode
    // change" with the stronger claim that makes clearing there WRONG — the
    // error is not merely still SHOWN, it is still TRUE, re-derived by a second
    // submit that the component blocks for the same reason as the first.
    //
    // Both halves are load-bearing. Without the pre-submit assertion the second
    // submit would re-raise the message and the case would pass on a component
    // that cleared it; without the second submit it would pass on a component
    // that only left a message it no longer believes.
    it("keeps the specific-targeting error across a Mode change, because the error is still true there", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();
      chooseSpecificTargeting();

      submit();
      expect(await screen.findByText(BLANK_TARGETS_ERROR)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("radio", { name: RE_MODE_OPT_IN }));

      expect(screen.getByText(BLANK_TARGETS_ERROR)).toBeInTheDocument();
      // The two facts the message asserts, both untouched by the Mode click.
      expect(
        screen.getByRole("radio", { name: RE_TARGETING_SPECIFIC })
      ).toBeChecked();
      expect(screen.getByLabelText(RE_TARGET_IDS_FIELD)).toHaveValue("");

      submit();

      await waitFor(() =>
        expect(screen.getByText(BLANK_TARGETS_ERROR)).toBeInTheDocument()
      );
      expect(transport.createRequests()).toHaveLength(0);
      expect(
        screen.getByRole("button", { name: RE_CREATE_BUTTON })
      ).toBeInTheDocument();
    });

    // ISS-7004's other anti-vacuous sibling, kept: the error is not dropped on
    // every form edit either, so a component that cleared it on any state
    // change still fails. Unlike the Mode case above this one makes no
    // still-true claim — typing a target DOES falsify the message, and that it
    // survives is current behaviour this pins rather than endorses.
    it("keeps the specific-targeting error while the targets textarea is edited", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();
      chooseSpecificTargeting();

      submit();
      expect(await screen.findByText(BLANK_TARGETS_ERROR)).toBeInTheDocument();

      typeTargets("target-a");

      expect(screen.getByText(BLANK_TARGETS_ERROR)).toBeInTheDocument();
      expect(transport.createRequests()).toHaveLength(0);
    });

    // ISS-7206, the headline. ISS-7004 cleared ONE error slot on a targeting
    // change; a server rejection lived in that same slot, so switching back to
    // "All compute targets" also erased the only record of what the server said
    // — the one message an admin cannot re-derive by reading the form. The
    // rejection is a fact about a past request; no radio click falsifies it.
    it("keeps a server rejection when targeting switches back to `all`", async () => {
      const transport = makeTransport();
      transport.failNextCreate();
      render(<Harness transport={transport} />);
      openModal();
      chooseSpecificTargeting();
      typeTargets("compute-target-x");

      submit();
      expect(
        await screen.findByText(CREATE_FAILURE_MESSAGE)
      ).toBeInTheDocument();
      expect(transport.createRequests()).toHaveLength(1);

      fireEvent.click(screen.getByRole("radio", { name: RE_TARGETING_ALL }));

      expect(screen.getByText(CREATE_FAILURE_MESSAGE)).toBeInTheDocument();
      // Still the live modal, not a survivor of an unmounted tree.
      expect(
        screen.getByRole("button", { name: RE_CREATE_BUTTON })
      ).toBeInTheDocument();

      submit();

      await waitFor(() => expect(transport.createRequests()).toHaveLength(2));
      expect(transport.createRequests()[1].body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
      });
    });

    // The render treatment the split buys. Under one slot the newer message
    // overwrote the older, so a blocked submit silently swallowed the server's
    // rejection; both are true here, so both are on screen, oldest first.
    it("shows a server rejection and a blocked submit together, rejection first", async () => {
      const transport = makeTransport();
      transport.failNextCreate();
      render(<Harness transport={transport} />);
      openModal();

      submit();
      expect(
        await screen.findByText(CREATE_FAILURE_MESSAGE)
      ).toBeInTheDocument();

      chooseSpecificTargeting();
      submit();
      expect(await screen.findByText(BLANK_TARGETS_ERROR)).toBeInTheDocument();

      expect(
        screen.getAllByRole("alert").map((node) => node.textContent)
      ).toEqual([CREATE_FAILURE_MESSAGE, BLANK_TARGETS_ERROR]);
      // The blocked submit issued nothing, so the rejection is still the last
      // word from the server rather than a message about a superseded request.
      expect(transport.createRequests()).toHaveLength(1);
    });

    // The other side of the boundary: the rejection is stale exactly when a new
    // request replaces it, so it must be gone by the time the next create is in
    // flight — never a stale rejection sitting beside a "Creating…" spinner.
    // Asserted while the create is HELD open, because the success path unmounts
    // the modal and would make any post-hoc "the text is gone" vacuous.
    it("drops the server rejection once the next create is actually issued", async () => {
      const transport = makeTransport();
      transport.failNextCreate();
      render(<Harness transport={transport} />);
      openModal();

      submit();
      expect(
        await screen.findByText(CREATE_FAILURE_MESSAGE)
      ).toBeInTheDocument();

      const release = transport.holdNextCreate();
      submit();

      expect(
        await screen.findByRole("button", { name: RE_CREATING })
      ).toBeInTheDocument();
      expect(
        screen.queryByText(CREATE_FAILURE_MESSAGE)
      ).not.toBeInTheDocument();

      release();
      await waitFor(() => expect(transport.createRequests()).toHaveLength(2));
      // The superseding request is asserted on its BODY, not just its count:
      // a rejection is only legitimately dropped by a request that is actually
      // the one the form now describes.
      expect(transport.createRequests()[1].body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
      });
    });

    // The composite the split exists to answer, which no single-error case
    // reaches: with BOTH messages true, one targeting click must clear exactly
    // one of them. A component that kept a single slot, or that cleared both,
    // or that cleared neither, disagrees with this case.
    it("clears only the validation error when targeting flips to `all` with both messages showing", async () => {
      const transport = makeTransport();
      transport.failNextCreate();
      render(<Harness transport={transport} />);
      openModal();

      submit();
      expect(
        await screen.findByText(CREATE_FAILURE_MESSAGE)
      ).toBeInTheDocument();

      chooseSpecificTargeting();
      submit();
      expect(await screen.findByText(BLANK_TARGETS_ERROR)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("radio", { name: RE_TARGETING_ALL }));

      expect(screen.queryByText(BLANK_TARGETS_ERROR)).not.toBeInTheDocument();
      expect(screen.getByText(CREATE_FAILURE_MESSAGE)).toBeInTheDocument();
      expect(screen.getAllByRole("alert")).toHaveLength(1);

      submit();

      await waitFor(() => expect(transport.createRequests()).toHaveLength(2));
      expect(transport.createRequests()[1].body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
      });
    });

    // `resetForm` gained a second error setter in ISS-7206, so the close path
    // has two things to remember instead of one. The sibling case below covers
    // the `submitError` half; this covers the half the split added.
    it("clears the specific-targeting error when the modal is reopened", async () => {
      const transport = makeTransport();
      render(<Harness transport={transport} />);
      openModal();
      chooseSpecificTargeting();

      submit();
      expect(await screen.findByText(BLANK_TARGETS_ERROR)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: RE_CANCEL }));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: RE_CREATE_BUTTON })
        ).not.toBeInTheDocument()
      );

      openModal();

      expect(
        await screen.findByRole("button", { name: RE_CREATE_BUTTON })
      ).toBeInTheDocument();
      expect(screen.queryByText(BLANK_TARGETS_ERROR)).not.toBeInTheDocument();

      submit();

      await waitFor(() => expect(transport.createRequests()).toHaveLength(1));
      expect(transport.createRequests()[0].body).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
      });
    });

    it("clears a previous failure message when the modal is reopened", async () => {
      const transport = makeTransport();
      transport.failNextCreate();
      render(<Harness transport={transport} />);
      openModal();

      submit();
      expect(
        await screen.findByText(CREATE_FAILURE_MESSAGE)
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: RE_CANCEL }));
      await waitFor(() =>
        expect(
          screen.queryByText(CREATE_FAILURE_MESSAGE)
        ).not.toBeInTheDocument()
      );

      openModal();

      expect(
        await screen.findByRole("button", { name: RE_CREATE_BUTTON })
      ).toBeInTheDocument();
      expect(
        screen.queryByText(CREATE_FAILURE_MESSAGE)
      ).not.toBeInTheDocument();
    });
  },
  SUITE_TIMEOUT_MS
);
