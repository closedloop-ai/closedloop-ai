import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsPageName as Page,
  OnboardingAnalyticsProperty as Property,
} from "@repo/api/src/types/onboarding-analytics";
import { Surface } from "@repo/api/src/types/surface-analytics";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceAnalyticsProvider } from "../surface-analytics-context";

afterEach(async () => {
  // Radix typeahead schedules focus on the next task. Let it finish before
  // unmounting its option refs, including when an assertion fails.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanup();
});

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

function SelectFixture({ selected }: { selected: (value: string) => void }) {
  return (
    <Select onValueChange={selected}>
      <SelectTrigger aria-label="Actions">
        <SelectValue placeholder="Actions" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem
          data-analytics-visible-source={JSON.stringify(["Save"])}
          value="save"
        >
          Save
        </SelectItem>
        <SelectItem
          data-analytics-visible-source={JSON.stringify(["Settings"])}
          value="settings"
        >
          Settings
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function CommandFixture({
  selected,
  disabled = false,
}: {
  selected: () => void;
  disabled?: boolean;
}) {
  return (
    <Command shouldFilter={false}>
      <CommandInput aria-label="Search actions" />
      <CommandList>
        <CommandItem
          data-analytics-visible-source={JSON.stringify(["Save"])}
          disabled={disabled}
          onSelect={selected}
          value="save"
        >
          Save
        </CommandItem>
      </CommandList>
    </Command>
  );
}

describe("keyboard action analytics", () => {
  it.each(["Enter", " "])(
    "tracks Radix Select option selection with %j",
    async (key) => {
      const selected = vi.fn();
      const view = mount(<SelectFixture selected={selected} />);
      fireEvent.keyDown(view.getByRole("combobox"), { key: "ArrowDown" });
      const option = await view.findByRole("option", { name: "Save" });
      act(() => option.focus());
      view.capture.mockClear();
      await act(async () => {
        fireEvent.keyDown(option, { key });
        await Promise.resolve();
      });
      expect(selected).toHaveBeenCalledWith("save");
      expect(view.names()).toEqual(["Save"]);
    }
  );

  it("does not count Space that Radix consumes as option typeahead", async () => {
    const selected = vi.fn();
    const view = mount(<SelectFixture selected={selected} />);
    fireEvent.keyDown(view.getByRole("combobox"), { key: "ArrowDown" });
    const option = await view.findByRole("option", { name: "Save" });
    act(() => option.focus());
    view.capture.mockClear();
    fireEvent.keyDown(option, { key: "s" });
    await act(async () => {
      fireEvent.keyDown(option, { key: " " });
      await Promise.resolve();
    });
    expect(selected).not.toHaveBeenCalled();
    expect(view.names()).toEqual([]);
  });

  it("does not count Space used for typeahead on the closed Radix Select trigger", async () => {
    const view = mount(<SelectFixture selected={vi.fn()} />);
    const trigger = view.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "s" });
    view.capture.mockClear();
    await act(async () => {
      fireEvent.keyDown(trigger, { key: " " });
      await Promise.resolve();
    });
    expect(view.queryByRole("listbox")).toBeNull();
    expect(view.names()).toEqual([]);
  });

  it("does not emit when cmdk has no enabled selected item", () => {
    const selected = vi.fn();
    const view = mount(<CommandFixture disabled selected={selected} />);
    fireEvent.keyDown(view.getByRole("combobox"), { key: "Enter" });
    expect(selected).not.toHaveBeenCalled();
    expect(view.names()).toEqual([]);
  });

  it("tracks cmdk Enter selection while ordinary editing is ignored", async () => {
    const selected = vi.fn();
    const view = mount(<CommandFixture selected={selected} />);
    const input = view.getByRole("combobox");
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard("hello world{Backspace}{ArrowDown}");
    expect(selected).not.toHaveBeenCalled();
    expect(view.names()).toEqual([]);
    await user.keyboard("{Enter}");
    expect(selected).toHaveBeenCalledOnce();
    expect(view.names()).toEqual(["Save"]);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "ignores cmdk IME confirmation %j",
    (ime) => {
      const selected = vi.fn();
      const view = mount(<CommandFixture selected={selected} />);
      fireEvent.keyDown(view.getByRole("combobox"), { key: "Enter", ...ime });
      expect(selected).not.toHaveBeenCalled();
      expect(view.names()).toEqual([]);
    }
  );

  it.each(["Enter", " "])(
    "tracks a PackCard-style role button with %j without native click",
    (key) => {
      const selected = vi.fn();
      const view = mount(
        // biome-ignore lint/a11y/useSemanticElements: Exercise the existing non-native PackCard keyboard contract.
        <div
          data-analytics-visible-source={JSON.stringify(["Save"])}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              selected();
            }
          }}
          role="button"
          tabIndex={0}
        >
          Save
        </div>
      );
      const card = view.getByRole("button");
      fireEvent.keyDown(card, { key });
      expect(selected).toHaveBeenCalledOnce();
      expect(view.names()).toEqual(["Save"]);
      // Some wrappers additionally synthesize a click after keyboard activation.
      fireEvent.click(card);
      expect(view.names()).toEqual(["Save"]);
    }
  );
});
