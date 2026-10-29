import { log } from "@repo/observability/log";
import NextError from "next/error";
import {
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GlobalError from "./global-error";

// The API workspace has no DOM environment, so the retry and the report are
// driven by calling the component with its effect captured instead of mounted.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEffect: vi.fn(),
}));
vi.mock("@repo/observability/log", () => ({ log: { error: vi.fn() } }));

const noop = () => undefined;

type ElementProps = {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
};

describe("API global error page", () => {
  it("renders the heading and a native retry button without design-system markup", () => {
    const markup = renderToStaticMarkup(
      <GlobalError error={new NextError({ statusCode: 500 })} reset={noop} />
    );

    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain("<h1>Oops, something went wrong</h1>");
    expect(markup).toContain('<button type="button">Try again</button>');
  });

  it("calls reset from the retry button and reports the digest", () => {
    const reset = vi.fn();
    const error = Object.assign(new NextError({ statusCode: 500 }), {
      digest: "digest-1",
    });

    const tree = GlobalError({ error, reset });
    for (const [effect] of vi.mocked(useEffect).mock.calls) {
      effect();
    }
    findButton(tree)?.props.onClick?.();

    expect(log.error).toHaveBeenCalledWith("global error boundary", {
      digest: "digest-1",
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

function findButton(node: ReactNode): ReactElement<ElementProps> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isValidElement<ElementProps>(node)) {
    return undefined;
  }
  if (node.type === "button") {
    return node;
  }
  return findButton(node.props.children);
}
