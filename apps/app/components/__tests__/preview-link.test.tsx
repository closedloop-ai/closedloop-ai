import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { PreviewLink } from "../preview-link";

const PREVIEW_REGEX = /preview/i;

afterEach(cleanup);

describe("PreviewLink", () => {
  test("renders link with correct attributes when URL is provided", () => {
    render(<PreviewLink url="https://preview.example.com" />);

    const link = screen.getByRole("link", { name: PREVIEW_REGEX });
    expect(link).toHaveAttribute("href", "https://preview.example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  test("renders hyphen when URL is null", () => {
    const { container } = render(<PreviewLink url={null} />);

    const span = container.querySelector("span");
    expect(span).toBeInTheDocument();
    expect(span).toHaveTextContent("-");
    expect(span).toHaveClass("text-muted-foreground");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("renders hyphen when URL is undefined", () => {
    const { container } = render(<PreviewLink url={undefined} />);

    const span = container.querySelector("span");
    expect(span).toBeInTheDocument();
    expect(span).toHaveTextContent("-");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("renders hyphen when URL is empty string", () => {
    const { container } = render(<PreviewLink url="" />);

    const span = container.querySelector("span");
    expect(span).toBeInTheDocument();
    expect(span).toHaveTextContent("-");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("link has correct styling classes", () => {
    render(<PreviewLink url="https://preview.example.com" />);

    const link = screen.getByRole("link", { name: PREVIEW_REGEX });
    expect(link).toHaveClass("inline-flex");
    expect(link).toHaveClass("items-center");
    expect(link).toHaveClass("gap-1");
    expect(link).toHaveClass("text-primary");
    expect(link).toHaveClass("text-sm");
    expect(link).toHaveClass("hover:underline");
  });

  test("includes external link icon", () => {
    const { container } = render(
      <PreviewLink url="https://preview.example.com" />
    );

    const icon = container.querySelector("svg");
    expect(icon).toBeInTheDocument();
  });
});
