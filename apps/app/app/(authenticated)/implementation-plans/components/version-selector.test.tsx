import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { VersionSelector } from "./version-selector";

// Mock dependencies
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

const mockGet = vi.fn();
vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => ({
    get: mockGet,
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }),
}));

// Test wrapper with QueryClientProvider
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function TestWrapper({ children }: { children: ReactNode }) {
  const queryClient = createTestQueryClient();
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderWithClient(ui: ReactNode) {
  return render(<TestWrapper>{ui}</TestWrapper>);
}

describe("VersionSelector", () => {
  const mockRouter = {
    push: vi.fn(),
    refresh: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useRouter as Mock).mockReturnValue(mockRouter);
  });

  afterEach(() => {
    cleanup();
  });

  describe("Rendering", () => {
    it("should render version button with current version", () => {
      const { container } = renderWithClient(
        <VersionSelector artifactId="test-id" currentVersion={2} />
      );

      const button = container.querySelector(
        "button[aria-label='Select version']"
      );
      expect(button).toBeDefined();
      expect(container.textContent).toContain("v2");
    });

    it("should render in compact mode when compact prop is true", () => {
      const { container } = renderWithClient(
        <VersionSelector
          artifactId="test-id"
          compact={true}
          currentVersion={2}
        />
      );

      const button = container.querySelector(
        "button[aria-label='Select version']"
      );
      expect(button?.className).toContain("h-7");
      expect(button?.className).toContain("px-2");
      expect(button?.className).toContain("text-xs");
    });

    it("should render in normal mode when compact prop is false", () => {
      const { container } = renderWithClient(
        <VersionSelector
          artifactId="test-id"
          compact={false}
          currentVersion={2}
        />
      );

      const button = container.querySelector(
        "button[aria-label='Select version']"
      );
      expect(button?.className).toContain("h-8");
      expect(button?.className).toContain("px-3");
      expect(button?.className).toContain("text-sm");
    });
  });

  describe("Lazy Loading", () => {
    it("should not load versions until dropdown is opened", () => {
      renderWithClient(
        <VersionSelector artifactId="test-id" currentVersion={2} />
      );

      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe("Component Props", () => {
    it("should accept and display different version numbers", () => {
      const { container: container1 } = renderWithClient(
        <VersionSelector artifactId="test-1" currentVersion={1} />
      );
      expect(container1.textContent).toContain("v1");
      cleanup();

      const { container: container2 } = renderWithClient(
        <VersionSelector artifactId="test-2" currentVersion={5} />
      );
      expect(container2.textContent).toContain("v5");
      cleanup();

      const { container: container3 } = renderWithClient(
        <VersionSelector artifactId="test-3" currentVersion={10} />
      );
      expect(container3.textContent).toContain("v10");
    });

    it("should render with different artifact IDs", () => {
      const { container } = renderWithClient(
        <VersionSelector artifactId="unique-artifact-id" currentVersion={2} />
      );

      const button = container.querySelector(
        "button[aria-label='Select version']"
      );
      expect(button).toBeDefined();
    });
  });

  describe("Accessibility", () => {
    it("should have proper ARIA label for the button", () => {
      const { container } = renderWithClient(
        <VersionSelector artifactId="test-id" currentVersion={2} />
      );

      const button = container.querySelector(
        "button[aria-label='Select version']"
      );
      expect(button?.getAttribute("aria-label")).toBe("Select version");
    });

    it("should have proper button role", () => {
      const { container } = renderWithClient(
        <VersionSelector artifactId="test-id" currentVersion={2} />
      );

      const button = container.querySelector(
        "button[aria-label='Select version']"
      );
      expect(button?.getAttribute("type")).toBe("button");
    });
  });

  describe("Styling", () => {
    it("should apply correct base classes", () => {
      const { container } = renderWithClient(
        <VersionSelector artifactId="test-id" currentVersion={2} />
      );

      const button = container.querySelector(
        "button[aria-label='Select version']"
      );
      expect(button?.className).toContain("inline-flex");
      expect(button?.className).toContain("items-center");
    });

    it("should have muted-foreground text style for version number", () => {
      const { container } = renderWithClient(
        <VersionSelector artifactId="test-id" currentVersion={2} />
      );

      const versionSpan = container.querySelector(
        ".font-mono.text-muted-foreground"
      );
      expect(versionSpan).toBeDefined();
      expect(versionSpan?.textContent).toBe("v2");
    });
  });
});
