import type { GridTableV2 as GridTableV2Component } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string };

/** More rows than the seed window paints, so a seeded client body differs. */
const ROW_COUNT = 25;
const ROWS: Row[] = Array.from({ length: ROW_COUNT }, (_, index) => ({
  id: `row-${index}`,
  name: `Row ${index}`,
}));
const COLUMNS = [{ id: "status", label: "Status" }];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

/**
 * A fresh module graph, so module scope is evaluated in the runtime the caller
 * set up: with no `window` for the server render, with jsdom's for hydration.
 */
async function loadGridTableV2(): Promise<typeof GridTableV2Component> {
  vi.resetModules();
  const module = await import(
    "@closedloop-ai/design-system/components/ui/grid-table-v2"
  );
  return module.GridTableV2;
}

function grid(GridTableV2: typeof GridTableV2Component) {
  return (
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 120px"
      items={ROWS}
      leadingLabel="Artifact"
      renderCell={() => "Active"}
      renderLead={(row) => <span>{row.name}</span>}
      virtualizeRows
    />
  );
}

describe("GridTableV2 windowed body hydration", () => {
  it("hydrates the server's row window without a recoverable error", async () => {
    vi.stubGlobal("window", undefined);
    const ServerGrid = await loadGridTableV2();
    const serverHtml = renderToString(grid(ServerGrid));
    vi.unstubAllGlobals();

    const ClientGrid = await loadGridTableV2();
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);
    const recoverableErrors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    // biome-ignore lint/suspicious/useAwait: act's async form flushes the hydration commit.
    await act(async () => {
      root = hydrateRoot(container, grid(ClientGrid), {
        onRecoverableError: (error) => {
          recoverableErrors.push(error);
        },
      });
    });

    expect(recoverableErrors).toEqual([]);
    act(() => root?.unmount());
  });
});
