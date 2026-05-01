import { DesktopSecurityStatus } from "@repo/api/src/types/compute-target";
import {
  DesktopProvisioningAttemptStatus,
  DesktopProvisioningPlatform,
  DesktopProvisioningReadinessStatus,
} from "@repo/api/src/types/electron";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadElectronAppStep } from "../download-electron-app-step";

const DOWNLOAD_FOR_MACOS = /download for macos/i;
const WAITING_FOR_DESKTOP = /waiting for closedloop desktop to start/i;
const DESKTOP_DETECTED = /closedloop desktop detected and running/i;
const DESKTOP_SETUP_COMPLETE = /closedloop desktop setup is complete/i;
const DESKTOP_SETUP_INCOMPLETE = /setup is not complete yet/i;
const DESKTOP_SETUP_UNKNOWN = /does not report setup status/i;
const GENERATE_API_KEY = /generate api key/i;
const MANUAL_SETUP = "Manual setup";
const DOWNLOAD_LATEST_VERSION = /download latest version/i;
const UPDATE_AVAILABLE = /update available/i;
const YOUR_API_KEY = /your api key/i;
const CONTINUE_BTN = /continue/i;
const SKIP_FOR_NOW = /skip for now/i;
const GENERATE_INSTALL_COMMAND = /generate install command/i;
const INSTALL_COMMAND = /install command/i;
const TERMINAL_INSTRUCTION = /paste it into macos terminal/i;
const AUTOMATED_SETUP_UNAVAILABLE = /automated setup is unavailable/i;
const MANUAL_LAUNCH_HINT = /after installing, launch the app/i;
const WORKSPACE_DIRECTORY = /workspace directory/i;
const SANDBOX_CONTROL_CHARACTER_ERROR =
  /sandbox directory cannot contain control characters/i;
const TEST_WORKSPACE_DIRECTORY = "~/workspace";

const mockUseLatestElectronRelease = vi.fn();
const mockUseElectronDetection = vi.fn();
const mockUseCreatePlatformApiKey = vi.fn();
const mockUseDesktopProvisioningCapability = vi.fn();
const mockUseCreateDesktopProvisioningAttempt = vi.fn();
const mockUseDesktopProvisioningAttemptStatus = vi.fn();
const mockUseDesktopProvisioningReadiness = vi.fn();
const mockUseComputeTargets = vi.fn();
const originalNavigatorPlatformDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "platform"
);

function enterWorkspaceDirectory(value = TEST_WORKSPACE_DIRECTORY) {
  fireEvent.change(screen.getByLabelText(WORKSPACE_DIRECTORY), {
    target: { value },
  });
}

vi.mock("@/hooks/queries/use-electron-release", () => ({
  useLatestElectronRelease: () => mockUseLatestElectronRelease(),
}));

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: () => mockUseElectronDetection(),
}));

vi.mock("@/hooks/queries/use-platform-api-keys", () => ({
  useCreatePlatformApiKey: () => mockUseCreatePlatformApiKey(),
}));

vi.mock("@/hooks/queries/use-desktop-provisioning", () => ({
  useDesktopProvisioningCapability: () =>
    mockUseDesktopProvisioningCapability(),
  useCreateDesktopProvisioningAttempt: () =>
    mockUseCreateDesktopProvisioningAttempt(),
  useDesktopProvisioningAttemptStatus: (...args: unknown[]) =>
    mockUseDesktopProvisioningAttemptStatus(...args),
  useDesktopProvisioningReadiness: () => mockUseDesktopProvisioningReadiness(),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
}));

const DEFAULT_ELECTRON_STATE = {
  detected: false,
  loading: false,
  port: null,
  version: null,
  machineName: null,
  gatewayId: null,
  capabilities: null,
  onboardingCompleted: null,
  checkedAt: null,
};

const MOCK_API_KEY_RESPONSE = {
  id: "key-1",
  organizationId: "org-1",
  userId: "user-1",
  name: "ClosedLoop Desktop",
  keyPrefix: "cl_",
  expiresAt: null,
  scopes: ["read", "write"],
  lastUsedAt: null,
  createdAt: new Date(),
  revokedAt: null,
  plaintext: "cl_test_secret_key_12345",
};

function openManualApiKeySetup() {
  fireEvent.click(screen.getByRole("button", { name: MANUAL_SETUP }));
}

function makeMockKeyMutate() {
  return vi.fn().mockImplementation((_input, options) => {
    options?.onSuccess?.(MOCK_API_KEY_RESPONSE);
  });
}

describe("DownloadElectronAppStep", () => {
  const mockOnNext = vi.fn();
  const mockMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });

    mockUseLatestElectronRelease.mockReturnValue({
      data: {
        downloadUrl: "https://example.com/closedloop-1.0.0.dmg",
        version: "1.0.0",
        releaseNotes: "Initial release",
      },
      isLoading: false,
    });

    mockUseElectronDetection.mockReturnValue(DEFAULT_ELECTRON_STATE);

    mockUseCreatePlatformApiKey.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });
    mockUseDesktopProvisioningCapability.mockReturnValue({
      data: {
        automatedManagedProvisioningEnabled: false,
        supportedPlatform: DesktopProvisioningPlatform.Darwin,
      },
      isLoading: false,
    });
    mockUseCreateDesktopProvisioningAttempt.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    mockUseDesktopProvisioningAttemptStatus.mockReturnValue({
      data: undefined,
      isError: false,
      isLoading: false,
      isPending: false,
    });
    mockUseDesktopProvisioningReadiness.mockReturnValue({
      data: { status: DesktopProvisioningReadinessStatus.Incomplete },
      isError: false,
      isLoading: false,
      isPending: false,
    });
    mockUseComputeTargets.mockReturnValue({
      data: [],
      isError: false,
      isLoading: false,
      isPending: false,
    });
  });

  afterEach(() => {
    if (originalNavigatorPlatformDescriptor) {
      Object.defineProperty(
        navigator,
        "platform",
        originalNavigatorPlatformDescriptor
      );
      return;
    }
    Reflect.deleteProperty(navigator, "platform");
  });

  describe("Download link", () => {
    it("renders the download link with the correct URL from the release data", () => {
      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      const downloadLink = screen.getByRole("link", {
        name: DOWNLOAD_FOR_MACOS,
      });
      expect(downloadLink).toBeInTheDocument();
      expect(downloadLink).toHaveAttribute(
        "href",
        "https://example.com/closedloop-1.0.0.dmg"
      );
    });

    it("renders the version number from the release data", () => {
      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByText("Version 1.0.0")).toBeInTheDocument();
    });

    it("renders 'Latest version' when no version is available", () => {
      mockUseLatestElectronRelease.mockReturnValue({
        data: undefined,
        isLoading: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByText("Latest version")).toBeInTheDocument();
    });

    it("renders download link with fallback '#' href when downloadUrl is not available", () => {
      mockUseLatestElectronRelease.mockReturnValue({
        data: undefined,
        isLoading: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      const downloadLink = screen.getByRole("link", {
        name: DOWNLOAD_FOR_MACOS,
      });
      expect(downloadLink).toHaveAttribute("href", "#");
    });

    it("shows a loading spinner while release is loading", () => {
      mockUseLatestElectronRelease.mockReturnValue({
        data: undefined,
        isLoading: true,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      const downloadLink = screen.getByRole("link", {
        name: DOWNLOAD_FOR_MACOS,
      });
      expect(downloadLink).toHaveAttribute("aria-disabled", "true");
      expect(downloadLink.querySelector(".animate-spin")).not.toBeNull();
    });
  });

  describe("Electron detection status transitions", () => {
    it("shows waiting state when detecting and not yet detected", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: false,
        loading: true,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getAllByText(WAITING_FOR_DESKTOP)).not.toHaveLength(0);
    });

    it("shows download button when not detecting and not detected", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: false,
        loading: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(
        screen.getByRole("link", { name: DOWNLOAD_FOR_MACOS })
      ).toBeInTheDocument();
      expect(screen.getByText(MANUAL_LAUNCH_HINT)).toBeInTheDocument();
    });

    it("keeps manual download instructions inside the collapsed manual setup section when automated setup is available", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: false,
        loading: false,
      });
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(
        screen.getByRole("button", { name: MANUAL_SETUP })
      ).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText(MANUAL_LAUNCH_HINT)).not.toBeInTheDocument();
    });

    it("opens manual setup by default on unsupported operating systems", () => {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: "Win32",
      });
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(
        screen.getByRole("button", { name: MANUAL_SETUP })
      ).toHaveAttribute("aria-expanded", "true");
    });

    it("shows detected state when Electron is running", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        port: 19_432,
        version: "1.0.0",
        checkedAt: Date.now(),
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByText(DESKTOP_DETECTED)).toBeInTheDocument();
      expect(screen.getByText(DESKTOP_SETUP_UNKNOWN)).toBeInTheDocument();
    });

    it("does not show incomplete setup while server readiness is pending or failed", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        onboardingCompleted: false,
        port: 19_432,
        version: "1.0.0",
        checkedAt: Date.now(),
      });
      mockUseDesktopProvisioningReadiness.mockReturnValue({
        data: undefined,
        isError: false,
        isLoading: true,
        isPending: true,
      });

      const { rerender } = render(
        <DownloadElectronAppStep onNext={mockOnNext} />
      );

      expect(screen.getByText(DESKTOP_SETUP_UNKNOWN)).toBeInTheDocument();
      expect(
        screen.queryByText(DESKTOP_SETUP_INCOMPLETE)
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: CONTINUE_BTN })).toBeDisabled();

      mockUseDesktopProvisioningReadiness.mockReturnValue({
        data: undefined,
        isError: true,
        isLoading: false,
        isPending: false,
      });
      rerender(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByText(DESKTOP_SETUP_UNKNOWN)).toBeInTheDocument();
      expect(
        screen.queryByText(DESKTOP_SETUP_INCOMPLETE)
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: CONTINUE_BTN })).toBeDisabled();
      expect(mockOnNext).not.toHaveBeenCalled();
    });

    it("shows setup complete when the matching compute target is protected", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        gatewayId: "019dd8f5-5a1a-4bce-ae72-a3c973850f81",
        onboardingCompleted: false,
        port: 19_432,
        version: "1.0.0",
        checkedAt: Date.now(),
      });
      mockUseComputeTargets.mockReturnValue({
        data: [
          {
            gatewayId: "019dd8f5-5a1a-4bce-ae72-a3c973850f81",
            security: { status: DesktopSecurityStatus.Protected },
          },
        ],
        isError: false,
        isLoading: false,
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByText(DESKTOP_SETUP_COMPLETE)).toBeInTheDocument();
    });

    it("shows the detected running version instead of the latest release version", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        port: 19_432,
        version: "0.9.0",
        checkedAt: Date.now(),
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByText("Version 0.9.0")).toBeInTheDocument();
      expect(screen.queryByText("Version 1.0.0")).not.toBeInTheDocument();
    });

    it("calls out when the detected Electron version is older than the latest release", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        port: 19_432,
        version: "0.9.0",
        checkedAt: Date.now(),
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByText(UPDATE_AVAILABLE)).toBeInTheDocument();
      expect(
        screen.getByText(
          "ClosedLoop Desktop version 0.9.0 is running. Version 1.0.0 is available."
        )
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: DOWNLOAD_LATEST_VERSION })
      ).toHaveAttribute("href", "https://example.com/closedloop-1.0.0.dmg");
    });

    it("does not call out an update when the detected version matches the latest release", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        port: 19_432,
        version: "1.0.0",
        checkedAt: Date.now(),
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.queryByText(UPDATE_AVAILABLE)).not.toBeInTheDocument();
      expect(screen.getByText(DESKTOP_DETECTED)).toBeInTheDocument();
    });

    it("shows 'Running' badge in header when Electron is detected", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        port: 19_432,
        checkedAt: Date.now(),
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByText("Running")).toBeInTheDocument();
    });

    it("does not show the API key section when Electron is not detected", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: false,
        loading: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(
        screen.queryByRole("button", { name: GENERATE_API_KEY })
      ).not.toBeInTheDocument();
    });

    it("shows manual setup collapsed when Electron is detected", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        port: 19_432,
        checkedAt: Date.now(),
      });
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByText(MANUAL_SETUP)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: GENERATE_API_KEY })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: MANUAL_SETUP })
      ).toHaveAttribute("aria-expanded", "false");

      openManualApiKeySetup();

      expect(
        screen.getByRole("button", { name: MANUAL_SETUP })
      ).toHaveAttribute("aria-expanded", "true");
      expect(
        screen.getByRole("button", { name: GENERATE_API_KEY })
      ).toBeInTheDocument();
    });
  });

  describe("API key generation flow", () => {
    beforeEach(() => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        port: 19_432,
        checkedAt: Date.now(),
      });
    });

    it("calls the mutation with correct arguments when Generate API Key is clicked", () => {
      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      openManualApiKeySetup();

      const generateButton = screen.getByRole("button", {
        name: GENERATE_API_KEY,
      });
      fireEvent.click(generateButton);

      expect(mockMutate).toHaveBeenCalledWith(
        { name: "ClosedLoop Desktop" },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );
    });

    it("displays the generated API key after successful mutation", async () => {
      mockUseCreatePlatformApiKey.mockReturnValue({
        mutate: makeMockKeyMutate(),
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      openManualApiKeySetup();

      const generateButton = screen.getByRole("button", {
        name: GENERATE_API_KEY,
      });
      fireEvent.click(generateButton);

      await waitFor(() => {
        const keyInput = screen.getByRole("textbox", {
          name: YOUR_API_KEY,
        }) as HTMLInputElement;
        expect(keyInput).toBeInTheDocument();
        expect(keyInput.value).toBe("cl_test_secret_key_12345");
      });
    });

    it("hides the Generate API Key button after a key is generated", async () => {
      mockUseCreatePlatformApiKey.mockReturnValue({
        mutate: makeMockKeyMutate(),
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      openManualApiKeySetup();

      fireEvent.click(screen.getByRole("button", { name: GENERATE_API_KEY }));

      await waitFor(() => {
        expect(
          screen.queryByRole("button", { name: GENERATE_API_KEY })
        ).not.toBeInTheDocument();
      });
    });

    it("disables the Generate API Key button while the mutation is pending", () => {
      mockUseCreatePlatformApiKey.mockReturnValue({
        mutate: mockMutate,
        isPending: true,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      openManualApiKeySetup();

      expect(
        screen.getByRole("button", { name: GENERATE_API_KEY })
      ).toBeDisabled();
    });

    it("copies the generated key to clipboard when copy button is clicked", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });

      mockUseCreatePlatformApiKey.mockReturnValue({
        mutate: makeMockKeyMutate(),
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      openManualApiKeySetup();

      fireEvent.click(screen.getByRole("button", { name: GENERATE_API_KEY }));

      await waitFor(() => {
        expect(
          screen.getByRole("textbox", { name: YOUR_API_KEY })
        ).toBeInTheDocument();
      });

      const copyButton = screen.getByRole("button", { name: "" });
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("cl_test_secret_key_12345");
      });
    });
  });

  describe("automated provisioning flow", () => {
    it("renders manual fallback when server-side provisioning is disabled", () => {
      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByText(AUTOMATED_SETUP_UNAVAILABLE)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: GENERATE_INSTALL_COMMAND })
      ).not.toBeInTheDocument();
    });

    it("marks the workspace directory field as required", () => {
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByLabelText(WORKSPACE_DIRECTORY)).toBeRequired();
    });

    it("creates an attempt-backed command without API or relay origins", async () => {
      const mutate = vi.fn().mockImplementation((_input, options) => {
        options?.onSuccess?.({
          onboardingAttemptId: "attempt-123",
          expiresAt: "2026-04-27T18:00:00.000Z",
        });
      });
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });
      mockUseCreateDesktopProvisioningAttempt.mockReturnValue({
        mutate,
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      enterWorkspaceDirectory();
      fireEvent.click(
        screen.getByRole("button", { name: GENERATE_INSTALL_COMMAND })
      );

      expect(mutate).toHaveBeenCalledWith(
        {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: globalThis.location.origin,
        },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );

      await waitFor(() => {
        const command = screen.getByRole("textbox", {
          name: INSTALL_COMMAND,
        }) as HTMLTextAreaElement;
        expect(screen.getByText(TERMINAL_INSTRUCTION)).toBeInTheDocument();
        expect(command.value).toContain(
          "CL_ONBOARDING_ATTEMPT_ID='attempt-123'"
        );
        expect(command.value).toContain(
          `CL_WEB_APP_ORIGIN='${globalThis.location.origin}'`
        );
        expect(command.value).toContain(
          "CL_DESKTOP_DOWNLOAD_URL='https://example.com/closedloop-1.0.0.dmg'"
        );
        expect(command.value).toContain("/api/desktop/install.sh");
        expect(command.value).not.toContain("api.closedloop.ai");
        expect(command.value).not.toContain("relay.closedloop.ai");
        expect(command.value).not.toContain("sk_live_");
      });
    });

    it("clears stale commands and shows generic inline copy when attempt creation fails", async () => {
      let mutateCallCount = 0;
      const mutate = vi.fn().mockImplementation((_input, options) => {
        mutateCallCount += 1;
        if (mutateCallCount === 1) {
          options?.onSuccess?.({
            onboardingAttemptId: "attempt-123",
            expiresAt: "2026-04-27T18:00:00.000Z",
          });
          return;
        }
        options?.onError?.(new Error("raw backend error"));
      });
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });
      mockUseCreateDesktopProvisioningAttempt.mockReturnValue({
        mutate,
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      enterWorkspaceDirectory();
      fireEvent.click(
        screen.getByRole("button", { name: GENERATE_INSTALL_COMMAND })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("textbox", { name: INSTALL_COMMAND })
        ).toBeInTheDocument();
      });

      fireEvent.click(
        screen.getByRole("button", { name: GENERATE_INSTALL_COMMAND })
      );

      await waitFor(() => {
        expect(
          screen.queryByRole("textbox", { name: INSTALL_COMMAND })
        ).not.toBeInTheDocument();
      });
      expect(
        screen.getByText(
          "Failed to generate install command. Please try again."
        )
      ).toBeInTheDocument();
      expect(screen.queryByText("raw backend error")).not.toBeInTheDocument();
    });

    it("rejects sandbox values with control characters before creating an attempt", () => {
      const mutate = vi.fn();
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });
      mockUseCreateDesktopProvisioningAttempt.mockReturnValue({
        mutate,
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      enterWorkspaceDirectory(`${TEST_WORKSPACE_DIRECTORY}\tsecrets`);
      fireEvent.click(
        screen.getByRole("button", { name: GENERATE_INSTALL_COMMAND })
      );

      expect(mutate).not.toHaveBeenCalled();
      expect(
        screen.getByText(SANDBOX_CONTROL_CHARACTER_ERROR)
      ).toBeInTheDocument();
    });

    it("allows control characters trimmed from the workspace value", async () => {
      const mutate = vi.fn().mockImplementation((_input, options) => {
        options?.onSuccess?.({
          onboardingAttemptId: "attempt-123",
          expiresAt: "2026-04-27T18:00:00.000Z",
        });
      });
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });
      mockUseCreateDesktopProvisioningAttempt.mockReturnValue({
        mutate,
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      enterWorkspaceDirectory(`\t${TEST_WORKSPACE_DIRECTORY}\n`);
      fireEvent.click(
        screen.getByRole("button", { name: GENERATE_INSTALL_COMMAND })
      );

      await waitFor(() => {
        const command = screen.getByRole("textbox", {
          name: INSTALL_COMMAND,
        }) as HTMLTextAreaElement;
        expect(command.value).toContain(
          `CL_SANDBOX_BASE_DIRECTORY='${TEST_WORKSPACE_DIRECTORY}'`
        );
      });
      expect(
        screen.queryByText(SANDBOX_CONTROL_CHARACTER_ERROR)
      ).not.toBeInTheDocument();
    });
  });

  describe("Continue button and navigation", () => {
    it("disables Continue button when Electron is not detected", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: false,
        loading: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByRole("button", { name: CONTINUE_BTN })).toBeDisabled();
    });

    it("enables Continue button after Electron is detected and API key is generated", async () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        port: 19_432,
        checkedAt: Date.now(),
      });

      mockUseCreatePlatformApiKey.mockReturnValue({
        mutate: makeMockKeyMutate(),
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      openManualApiKeySetup();

      fireEvent.click(screen.getByRole("button", { name: GENERATE_API_KEY }));

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: CONTINUE_BTN })
        ).not.toBeDisabled();
      });
    });

    it("enables Continue for detected legacy Desktop versions with unknown setup status", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        onboardingCompleted: null,
        gatewayId: null,
        port: 19_432,
        checkedAt: Date.now(),
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(
        screen.getByRole("button", { name: CONTINUE_BTN })
      ).not.toBeDisabled();
      expect(screen.getByText(DESKTOP_SETUP_UNKNOWN)).toBeInTheDocument();
    });

    it("keeps Continue disabled until known automated provisioning completes", async () => {
      const mutate = vi.fn().mockImplementation((_input, options) => {
        options?.onSuccess?.({
          onboardingAttemptId: "attempt-123",
          expiresAt: "2026-04-27T18:00:00.000Z",
        });
      });
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        onboardingCompleted: false,
        gatewayId: "019dd8f5-5a1a-4bce-ae72-a3c973850f81",
        port: 19_432,
        checkedAt: Date.now(),
      });
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });
      mockUseCreateDesktopProvisioningAttempt.mockReturnValue({
        mutate,
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      expect(screen.getByRole("button", { name: CONTINUE_BTN })).toBeDisabled();

      enterWorkspaceDirectory();
      fireEvent.click(
        screen.getByRole("button", { name: GENERATE_INSTALL_COMMAND })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("textbox", { name: INSTALL_COMMAND })
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: CONTINUE_BTN })
        ).toBeDisabled();
      });
    });

    it("auto-continues after generated automated provisioning reports complete", async () => {
      const mutate = vi.fn().mockImplementation((_input, options) => {
        options?.onSuccess?.({
          onboardingAttemptId: "attempt-123",
          expiresAt: "2026-04-27T18:00:00.000Z",
        });
      });
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: false,
        loading: false,
      });
      mockUseDesktopProvisioningAttemptStatus.mockReturnValue({
        data: undefined,
        isError: false,
        isLoading: false,
        isPending: false,
      });
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });
      mockUseCreateDesktopProvisioningAttempt.mockReturnValue({
        mutate,
        isPending: false,
      });

      const { rerender } = render(
        <DownloadElectronAppStep onNext={mockOnNext} />
      );

      enterWorkspaceDirectory();
      fireEvent.click(
        screen.getByRole("button", { name: GENERATE_INSTALL_COMMAND })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("textbox", { name: INSTALL_COMMAND })
        ).toBeInTheDocument();
      });

      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        onboardingCompleted: false,
        gatewayId: "019dd8f5-5a1a-4bce-ae72-a3c973850f81",
        port: 19_432,
        version: "1.0.0",
        checkedAt: Date.now(),
      });
      mockUseDesktopProvisioningAttemptStatus.mockReturnValue({
        data: {
          onboardingAttemptId: "attempt-123",
          status: DesktopProvisioningAttemptStatus.Complete,
        },
        isError: false,
        isLoading: false,
        isPending: false,
      });
      rerender(<DownloadElectronAppStep onNext={mockOnNext} />);

      await waitFor(() => {
        expect(screen.getByText(DESKTOP_SETUP_COMPLETE)).toBeInTheDocument();
        expect(mockOnNext).toHaveBeenCalledTimes(1);
      });
    });

    it("auto-continues when generated provisioning completes without localhost detection", async () => {
      const mutate = vi.fn().mockImplementation((_input, options) => {
        options?.onSuccess?.({
          onboardingAttemptId: "attempt-123",
          expiresAt: "2026-04-27T18:00:00.000Z",
        });
      });
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: false,
        loading: false,
      });
      mockUseDesktopProvisioningCapability.mockReturnValue({
        data: {
          automatedManagedProvisioningEnabled: true,
          supportedPlatform: DesktopProvisioningPlatform.Darwin,
        },
        isLoading: false,
      });
      mockUseCreateDesktopProvisioningAttempt.mockReturnValue({
        mutate,
        isPending: false,
      });

      const { rerender } = render(
        <DownloadElectronAppStep onNext={mockOnNext} />
      );

      enterWorkspaceDirectory();
      fireEvent.click(
        screen.getByRole("button", { name: GENERATE_INSTALL_COMMAND })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("textbox", { name: INSTALL_COMMAND })
        ).toBeInTheDocument();
      });

      mockUseDesktopProvisioningAttemptStatus.mockReturnValue({
        data: {
          onboardingAttemptId: "attempt-123",
          status: DesktopProvisioningAttemptStatus.Complete,
        },
        isError: false,
        isLoading: false,
        isPending: false,
      });
      rerender(<DownloadElectronAppStep onNext={mockOnNext} />);

      await waitFor(() => {
        expect(mockOnNext).toHaveBeenCalledTimes(1);
      });
    });

    it("auto-continues when an existing Desktop-managed target is already ready", async () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: false,
        loading: false,
      });
      mockUseDesktopProvisioningReadiness.mockReturnValue({
        data: {
          status: DesktopProvisioningReadinessStatus.Complete,
          gatewayId: "gateway-1",
          computeTargetId: "target-1",
        },
        isError: false,
        isLoading: false,
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      await waitFor(() => {
        expect(mockOnNext).toHaveBeenCalledTimes(1);
      });
    });

    it("calls onNext when Skip for now is clicked", () => {
      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      fireEvent.click(screen.getByRole("button", { name: SKIP_FOR_NOW }));

      expect(mockOnNext).toHaveBeenCalledTimes(1);
    });
  });
});
