import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsPageName as Page,
  OnboardingAnalyticsProperty as Property,
} from "@repo/api/src/types/onboarding-analytics";
import { Surface } from "@repo/api/src/types/surface-analytics";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonName } from "../button-click-tracker";
import { SurfaceAnalyticsProvider } from "../surface-analytics-context";

afterEach(cleanup);

function mount(children: ReactNode) {
  const capture = vi.fn();
  const view = render(
    <SurfaceAnalyticsProvider
      capture={capture}
      getClickPage={() => ({ pageName: Page.Settings, entry: "/settings" })}
      surface={Surface.Web}
    >
      {children}
    </SurfaceAnalyticsProvider>
  );
  return {
    ...view,
    capture,
    names: () =>
      capture.mock.calls
        .filter(([event]) => event === Event.ButtonClicked)
        .map(([, properties]) => properties[Property.ButtonName]),
  };
}

describe("actual product controls", () => {
  it("tracks Radix tabs once for mouse and keyboard activation", async () => {
    const selected = vi.fn();
    const view = mount(
      <Tabs defaultValue="one" onValueChange={selected}>
        <TabsList>
          <TabsTrigger
            data-analytics-visible-source={JSON.stringify(["Overview"])}
            value="one"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            data-analytics-visible-source={JSON.stringify(["Settings"])}
            value="two"
          >
            Settings
          </TabsTrigger>
        </TabsList>
      </Tabs>
    );
    const user = userEvent.setup();
    await user.click(view.getByRole("tab", { name: "Settings" }));
    expect(selected).toHaveBeenLastCalledWith("two");
    expect(view.names()).toEqual(["Settings"]);
    act(() => view.getByRole("tab", { name: "Overview" }).focus());
    await user.keyboard("{Enter}");
    expect(view.names()).toEqual(["Settings", "Overview"]);
    await user.keyboard("{ArrowRight}");
    await vi.waitFor(() =>
      expect(view.names()).toEqual(["Settings", "Overview", "Settings"])
    );
  });

  it("waits for activation when tabs use manual keyboard selection", async () => {
    const view = mount(
      <Tabs activationMode="manual" defaultValue="one">
        <TabsList>
          <TabsTrigger
            data-analytics-visible-source={JSON.stringify(["Overview"])}
            value="one"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            data-analytics-visible-source={JSON.stringify(["Settings"])}
            value="two"
          >
            Settings
          </TabsTrigger>
        </TabsList>
      </Tabs>
    );
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{ArrowRight}");
    await vi.waitFor(() =>
      expect(globalThis.document.activeElement).toBe(
        view.getByRole("tab", { name: "Settings" })
      )
    );
    expect(view.names()).toEqual([]);
    await user.keyboard("{Enter}");
    expect(view.names()).toEqual(["Settings"]);
  });

  it("tracks a dropdown trigger and a portaled menu action once", async () => {
    const selected = vi.fn();
    const view = mount(
      <DropdownMenu>
        <DropdownMenuTrigger
          data-analytics-visible-source={JSON.stringify(["Actions"])}
        >
          Actions
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            data-analytics-visible-source={JSON.stringify(["Save"])}
            onSelect={selected}
          >
            Save
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const user = userEvent.setup();
    await user.click(view.getByRole("button", { name: "Actions" }));
    await user.click(await view.findByRole("menuitem", { name: "Save" }));
    expect(selected).toHaveBeenCalledOnce();
    expect(view.names()).toEqual(["Actions", "Save"]);
  });

  it("does not count text-field editing as a row activation", () => {
    const view = mount(
      <div data-analytics-action="true" data-analytics-label="Select row">
        <input aria-label="Name" />
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          type="button"
        >
          Save
        </button>
      </div>
    );
    fireEvent.click(view.getByRole("textbox"));
    expect(view.names()).toEqual([]);
    fireEvent.click(view.getByRole("button"));
    expect(view.names()).toEqual(["Save"]);
  });

  it("counts explicit keyboard actions without requiring a native click", () => {
    const action = vi.fn();
    const view = mount(
      <button
        data-analytics-action="true"
        data-analytics-keyboard="true"
        data-analytics-label="Select session"
        data-analytics-label-source={JSON.stringify(["Select session"])}
        data-analytics-visible-source={JSON.stringify(["Save"])}
        onKeyDown={action}
        type="button"
      >
        private session
      </button>
    );
    fireEvent.keyDown(view.getByRole("button"), { key: "Enter" });
    expect(action).toHaveBeenCalledOnce();
    expect(view.names()).toEqual(["Select session"]);
  });

  it("counts a touch activation once", async () => {
    const action = vi.fn();
    const view = mount(
      <button
        data-analytics-visible-source={JSON.stringify(["Save"])}
        onClick={action}
        type="button"
      >
        Save
      </button>
    );
    await userEvent.pointer([
      { keys: "[TouchA>]", target: view.getByRole("button") },
      { keys: "[/TouchA]" },
    ]);
    expect(action).toHaveBeenCalledOnce();
    expect(view.names()).toEqual(["Save"]);
  });

  it("ignores copy hidden by CSS when selecting the visible label", () => {
    const view = render(
      <button
        data-analytics-visible-source={JSON.stringify(["Save"])}
        type="button"
      >
        Save<span style={{ display: "none" }}> private repository</span>
      </button>
    );
    expect(buttonName(view.getByRole("button"))).toBe("Save");
  });

  it("uses input labels and screen-reader labels without exposing private paths", () => {
    const view = render(
      <>
        <label data-analytics-text-source={JSON.stringify(["Save"])}>
          <input type="checkbox" />
          Save
        </label>
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          type="button"
        >
          <span
            className="sr-only"
            data-analytics-text-source={JSON.stringify(["Close"])}
          >
            Close
          </span>
        </button>
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          type="button"
        >
          README.md
        </button>
      </>
    );
    expect(buttonName(view.getByRole("checkbox"))).toBe("Save");
    expect(view.getAllByRole("button").map(buttonName)).toEqual([
      "Close",
      "Activate action",
    ]);
  });
});
