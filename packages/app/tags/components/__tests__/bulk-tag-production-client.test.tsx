import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import { toast } from "@repo/design-system/components/ui/sonner";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { useGridRowSelection } from "@repo/design-system/hooks/use-grid-row-selection";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiAdapter } from "../../../shared/api/api-adapter";
import { ApiAdapterProvider } from "../../../shared/api/provider";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { resetObservedSignedInIdentityForTests } from "../../../shared/auth/signed-in-identity";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { ArtifactBulkActionBar } from "../../../shared/components/generic-artifact-surface/bulk-action-bar";
import { makeQueryClient } from "../../../shared/query/query-client";
import { useBatchTagPerItem } from "../../hooks/use-batch-tag-per-item";
import { BULK_TAG_ACTION_LABEL } from "../../lib/bulk-tag-labels";
import { BulkTagMutation } from "../../lib/bulk-tag-mutation";
import { createDeferred } from "../../test-fixtures/deferred";
import { useBulkTagFamilyActions } from "../bulk-tag-action";

/**
 * DT-R02/R04/R07-R11 through the PRODUCTION query client. The lifecycle suite
 * runs on the story providers' plain client, which has no default mutation
 * error toast, so it cannot show that a thrown late rejection stays silent:
 * here `makeQueryClient`'s default `onError` is live, and the only thing
 * between a rejected tag write and a toast is the owner's suppression.
 */

const ROW_IDS = ["artifact-a", "artifact-b"];
const TAG = { id: "tag-a", name: "backend", color: TagColor.Blue };
const WRITE_PATH = `${BatchMutationRoute.EntityTags}/v2`;

const REJECTIONS = [
  { name: "HTTP 403", reject: respondWith(403) },
  { name: "HTTP 500", reject: respondWith(500) },
  {
    name: "a network failure",
    reject: () => Promise.reject(new TypeError("Failed to fetch")),
  },
] as const;

beforeEach(() => {
  resetObservedSignedInIdentityForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetObservedSignedInIdentityForTests();
});

describe("bulk tag rejections on the production query client", () => {
  it.each(REJECTIONS)(
    "shows $name inline, without a toast, while the interaction is current",
    async ({ reject }) => {
      const fixture = setup();
      const toastError = vi.spyOn(toast, "error").mockReturnValue("toast");
      await fixture.submit();

      await fixture.rejectWrite(reject);

      expect(await screen.findByRole("alert")).not.toBeEmptyDOMElement();
      expect(toastError).not.toHaveBeenCalled();
      expect(screen.getByTestId("selection")).toHaveTextContent(
        ROW_IDS.join(",")
      );
    }
  );

  it.each(REJECTIONS)(
    "drops $name that settles after the picker was dismissed",
    async ({ reject }) => {
      const fixture = setup();
      const toastError = vi.spyOn(toast, "error").mockReturnValue("toast");
      await fixture.submit();
      await fixture.user.keyboard("{Escape}");

      await fixture.rejectWrite(reject);

      expect(toastError).not.toHaveBeenCalled();
      await fixture.user.click(
        screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
      );
      expect(
        await screen.findByRole("button", { name: TAG.name })
      ).toBeVisible();
      expect(screen.queryByRole("alert")).toBeNull();
    }
  );

  it.each(REJECTIONS)(
    "drops $name that settles after the signed-in organization changed",
    async ({ reject }) => {
      const fixture = setup();
      const toastError = vi.spyOn(toast, "error").mockReturnValue("toast");
      await fixture.submit();
      fixture.switchOrganization();

      await fixture.rejectWrite(reject);

      expect(toastError).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    }
  );

  it("keeps the default error toast for a direct caller of the per-item hook", async () => {
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast");
    const client = makeQueryClient();
    const write = createDeferred<Response>();
    const { result } = renderHook(
      () => useBatchTagPerItem(BulkTagMutation.Add),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <Providers adapter={fixtureAdapter(write.promise)} client={client}>
            {children}
          </Providers>
        ),
      }
    );

    let settled: Promise<unknown> = Promise.resolve();
    act(() => {
      settled = result.current
        .mutateAsync({
          tagId: TAG.id,
          entityType: TagEntityType.Artifact,
          entityIds: ROW_IDS,
        })
        .catch((error: unknown) => error);
    });
    write.resolve(await respondWith(500)());
    await act(async () => {
      await settled;
    });

    expect(toastError).toHaveBeenCalledTimes(1);
  });
});

function setup() {
  const client = makeQueryClient();
  const write = createDeferred<Response>();
  const started = createDeferred<void>();
  const adapter = fixtureAdapter(write.promise, () => started.resolve());
  let orgId = "org_test";
  const tree = () => (
    <Providers adapter={adapter} client={client} orgId={orgId}>
      <Interaction />
    </Providers>
  );
  const view = render(tree());
  const user = userEvent.setup({ delay: null });
  return {
    user,
    submit: async () => {
      await user.click(
        screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
      );
      await user.click(await screen.findByRole("button", { name: TAG.name }));
      await started.promise;
    },
    switchOrganization: () => {
      orgId = "org_other";
      view.rerender(tree());
    },
    rejectWrite: async (reject: () => Promise<Response>) => {
      await act(async () => {
        write.resolve(reject());
        await write.promise.catch(() => undefined);
      });
      await waitFor(() =>
        expect(
          client
            .getMutationCache()
            .getAll()
            .some((mutation) => mutation.state.status === "error")
        ).toBe(true)
      );
      await act(async () => undefined);
    },
  };
}

function Interaction() {
  const targets = ROW_IDS.map((id) => ({
    artifactId: id,
    canApply: true,
    rowId: id,
  }));
  const actions = useBulkTagFamilyActions({
    addTargets: targets,
    removeTargets: targets,
  });
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(ROW_IDS)
  );
  const selection = useGridRowSelection({
    controller: { selectedIds, onChange: setSelectedIds },
    visibleRowIds: ROW_IDS,
  });
  return (
    <>
      <output data-testid="selection">
        {[...selection.selectedIds].sort().join(",")}
      </output>
      <ArtifactBulkActionBar
        actions={actions}
        getSelectionGeneration={selection.getSelectionGeneration}
        minimumSelectedRows={2}
        onClear={selection.clearSelection}
        onRetainSelection={selection.retainSelection}
        rowIds={[...selection.selectedIds]}
      />
    </>
  );
}

function Providers({
  adapter,
  children,
  client,
  orgId = "org_test",
}: {
  adapter: ApiAdapter;
  children: ReactNode;
  client: QueryClient;
  orgId?: string;
}) {
  return (
    <QueryClientProvider client={client}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter({ orgId })}>
        <ApiAdapterProvider adapter={adapter}>
          <TooltipProvider>{children}</TooltipProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

/** The catalog answers at once; the tag write waits for the scenario. */
function fixtureAdapter(
  write: Promise<Response>,
  onWrite: () => void = () => undefined
): ApiAdapter {
  return {
    resolveApiOrigin: () => "http://test.invalid",
    fetch: (input) => {
      const { pathname } = new URL(String(input));
      if (pathname === WRITE_PATH) {
        onWrite();
        return write;
      }
      return Promise.resolve(envelope(200, { success: true, data: [TAG] }));
    },
  };
}

function respondWith(status: number) {
  return () =>
    Promise.resolve(
      envelope(status, { success: false, error: "Fixture rejection" })
    );
}

function envelope(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
