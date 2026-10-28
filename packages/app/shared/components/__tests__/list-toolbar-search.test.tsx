import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LIST_TOOLBAR_SEARCH_LABEL } from "../list-toolbar-copy";
import { ListToolbarSearch } from "../list-toolbar-search";

afterEach(cleanup);

/** A host whose stored value trails the input by one keystroke, as a URL write does. */
function LaggingHost() {
  const [stored, setStored] = useState("");
  return (
    <ListToolbarSearch
      onChange={(next) => {
        setStored((previous) => {
          queueMicrotask(() => setStored(next));
          return previous;
        });
      }}
      value={stored}
    />
  );
}

function ControlledHost({ external }: { external: string }) {
  return <ListToolbarSearch onChange={() => undefined} value={external} />;
}

describe("ListToolbarSearch (ISS-13007)", () => {
  it("keeps every character typed quickly while the host value lags", async () => {
    const user = userEvent.setup({ delay: null });
    render(<LaggingHost />);
    const input = screen.getByRole("textbox", {
      name: LIST_TOOLBAR_SEARCH_LABEL,
    });

    await user.type(input, "branch name");

    expect(input).toHaveValue("branch name");
  });

  it("adopts an external change once the input is left", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ControlledHost external="" />);
    const input = screen.getByRole("textbox", {
      name: LIST_TOOLBAR_SEARCH_LABEL,
    });

    await user.click(input);
    rerender(<ControlledHost external="from link" />);
    await user.tab();

    expect(input).toHaveValue("from link");
  });

  it("adopts an external change straight away while it is not focused", () => {
    const { rerender } = render(<ControlledHost external="a" />);
    rerender(<ControlledHost external="" />);

    expect(
      screen.getByRole("textbox", { name: LIST_TOOLBAR_SEARCH_LABEL })
    ).toHaveValue("");
  });
});
