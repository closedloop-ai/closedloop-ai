import { expect, type Locator, type Page } from "@playwright/test";

/** Exercises the shared contract on a production host that has no row-move port. */
export async function expectDesktopRowPointerRefusal({
  destination,
  link,
  page,
  row,
  surface,
}: {
  destination: Locator;
  link: Locator;
  page: Page;
  row: Locator;
  surface: Locator;
}): Promise<void> {
  await expect(row).toHaveAttribute("draggable", "false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page.evaluate(
      () => globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
  ).toBe(true);
  await expect
    .poll(() => link.evaluate((element) => getComputedStyle(element).cursor))
    .toBe("pointer");

  const initialUrl = page.url();
  const observer = await row.evaluateHandle((element) => {
    const events = {
      captures: 0,
      clicks: [] as boolean[],
      drags: [] as ObservedNativeDrag[],
      pointerUps: [] as boolean[],
    };
    const controller = new AbortController();
    const options = { signal: controller.signal };
    element.addEventListener(
      "gotpointercapture",
      () => {
        events.captures += 1;
      },
      options
    );
    element.addEventListener(
      "pointerup",
      (event) => events.pointerUps.push(event.isTrusted),
      options
    );
    element.addEventListener(
      "click",
      (event) => events.clicks.push(event.isTrusted),
      options
    );
    element.ownerDocument.addEventListener(
      "dragstart",
      (event) => {
        // The browser's link drag stays native when this host has no row move.
        if (
          event.target instanceof globalThis.Node &&
          element.contains(event.target)
        ) {
          events.drags.push({
            ctrlKey: event.ctrlKey,
            defaultPrevented: event.defaultPrevented,
            metaKey: event.metaKey,
            trusted: event.isTrusted,
          });
        }
      },
      options
    );
    return { events, stop: () => controller.abort() };
  });

  try {
    const leadCell = row.locator("[data-grid-cell]").first();
    await leadCell.scrollIntoViewIfNeeded();
    const box = await leadCell.boundingBox();
    if (!box) {
      throw new Error("The production row has no visible lead cell");
    }
    // The lead cell's padding is inert; this movement is an input, not a policy threshold.
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 3, box.y + box.height / 2);
    await page.mouse.up();
    expect(await observer.evaluate(({ events }) => events)).toEqual({
      captures: 0,
      clicks: [true],
      drags: [],
      pointerUps: [true],
    });
    await expect(page).toHaveURL(initialUrl);
    const selectedBeforeDrag = await selectedRowIds(surface);

    const expectedDrags: ObservedNativeDrag[] = [];
    for (const modifier of [null, "Control", "Meta"] as const) {
      if (modifier) {
        await page.keyboard.down(modifier);
      }
      try {
        await link.dragTo(destination);
      } finally {
        if (modifier) {
          await page.keyboard.up(modifier);
        }
        await page.mouse.up();
      }
      // macOS Control-press stays contextual, so no link drag starts there; on
      // Linux Control is not a context gesture and the link drag stays native.
      if (modifier !== "Control" || process.platform !== "darwin") {
        expectedDrags.push({
          ctrlKey: modifier === "Control",
          defaultPrevented: false,
          metaKey: modifier === "Meta",
          trusted: true,
        });
      }
      const observed = await observer.evaluate(({ events }) => events);
      expect(observed.drags).toEqual(expectedDrags);
      expect(observed.captures).toBe(0);
      await expect(page).toHaveURL(initialUrl);
      await expect(
        surface.locator(
          '[data-interaction-state="dragging"], [data-interaction-state="drag-over"]'
        )
      ).toHaveCount(0);
      expect(await selectedRowIds(surface)).toEqual(selectedBeforeDrag);
      await expect(row).toHaveAttribute("draggable", "false");
      await expect
        .poll(() => row.evaluate((element) => getComputedStyle(element).cursor))
        .toBe("default");
      await expect
        .poll(() =>
          link.evaluate((element) => getComputedStyle(element).cursor)
        )
        .toBe("pointer");
    }
  } finally {
    await observer.evaluate(({ stop }) => stop());
    await observer.dispose();
  }
}

function selectedRowIds(surface: Locator): Promise<string[]> {
  return surface
    .locator(
      ':is([data-grid-row-id], [data-grid-card-id])[data-state="selected"]'
    )
    .evaluateAll((elements) =>
      elements.map(
        (element) =>
          element.getAttribute("data-grid-row-id") ??
          element.getAttribute("data-grid-card-id") ??
          ""
      )
    );
}

type ObservedNativeDrag = {
  ctrlKey: boolean;
  defaultPrevented: boolean;
  metaKey: boolean;
  trusted: boolean;
};
