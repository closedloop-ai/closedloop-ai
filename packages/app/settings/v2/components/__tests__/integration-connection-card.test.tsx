import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationConnectionCard } from "../integration-connection-card";

describe("IntegrationConnectionCard", () => {
  it("renders the title and description", () => {
    render(
      <IntegrationConnectionCard
        description="Connect this service to unlock more features."
        title="Example Integration"
      />
    );

    expect(screen.getByText("Example Integration")).toBeInTheDocument();
    expect(
      screen.getByText("Connect this service to unlock more features.")
    ).toBeInTheDocument();
  });

  it("shows a loading spinner and hides content when isLoading is true", () => {
    const { container } = render(
      <IntegrationConnectionCard
        actions={<button type="button">Connect</button>}
        banner={<div>Read-access banner</div>}
        description="desc"
        isLoading
        statusTitle="Connected"
        title="Example Integration"
      >
        <div>Child content</div>
      </IntegrationConnectionCard>
    );

    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Read-access banner")).not.toBeInTheDocument();
    expect(screen.queryByText("Child content")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect" })
    ).not.toBeInTheDocument();
  });

  it("renders the status title and description when provided", () => {
    render(
      <IntegrationConnectionCard
        description="desc"
        statusDescription="user@example.com"
        statusTitle="Connected to Example"
        title="Example Integration"
      />
    );

    expect(screen.getByText("Connected to Example")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
  });

  it("renders the actions slot", () => {
    render(
      <IntegrationConnectionCard
        actions={<button type="button">Disconnect</button>}
        description="desc"
        statusTitle="Connected"
        title="Example Integration"
      />
    );

    expect(
      screen.getByRole("button", { name: "Disconnect" })
    ).toBeInTheDocument();
  });

  it("renders banner content", () => {
    render(
      <IntegrationConnectionCard
        banner={<div>This integration has read access.</div>}
        description="desc"
        title="Example Integration"
      />
    );

    expect(
      screen.getByText("This integration has read access.")
    ).toBeInTheDocument();
  });

  it("renders children", () => {
    render(
      <IntegrationConnectionCard description="desc" title="Example Integration">
        <div>Custom child region</div>
      </IntegrationConnectionCard>
    );

    expect(screen.getByText("Custom child region")).toBeInTheDocument();
  });

  it("applies the provided className to the card", () => {
    const { container } = render(
      <IntegrationConnectionCard
        className="custom-card-class"
        description="desc"
        title="Example Integration"
      />
    );

    expect(container.querySelector('[data-slot="card"]')).toHaveClass(
      "custom-card-class"
    );
  });

  it("hides the status section when neither statusTitle nor actions are provided", () => {
    render(
      <IntegrationConnectionCard
        description="desc"
        statusDescription="Should not render without a title or actions"
        title="Example Integration"
      />
    );

    expect(
      screen.queryByText("Should not render without a title or actions")
    ).not.toBeInTheDocument();
  });
});
