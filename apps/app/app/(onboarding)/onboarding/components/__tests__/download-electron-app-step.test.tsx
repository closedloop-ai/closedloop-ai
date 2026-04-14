import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadElectronAppStep } from "../download-electron-app-step";

const DOWNLOAD_FOR_MACOS = /download for macos/i;
const WAITING_FOR_DESKTOP = /waiting for closedloop desktop to start/i;
const DESKTOP_DETECTED = /closedloop desktop detected and running/i;
const GENERATE_API_KEY = /generate api key/i;
const YOUR_API_KEY = /your api key/i;
const CONTINUE_BTN = /continue/i;
const SKIP_FOR_NOW = /skip for now/i;

const mockUseLatestElectronRelease = vi.fn();
const mockUseElectronDetection = vi.fn();
const mockUseCreatePlatformApiKey = vi.fn();

vi.mock("@/hooks/queries/use-electron-release", () => ({
  useLatestElectronRelease: () => mockUseLatestElectronRelease(),
}));

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: () => mockUseElectronDetection(),
}));

vi.mock("@/hooks/queries/use-platform-api-keys", () => ({
  useCreatePlatformApiKey: () => mockUseCreatePlatformApiKey(),
}));

const DEFAULT_ELECTRON_STATE = {
  detected: false,
  loading: false,
  port: null,
  version: null,
  machineName: null,
  capabilities: null,
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

      expect(screen.getByText(WAITING_FOR_DESKTOP)).toBeInTheDocument();
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

    it("shows the API key section when Electron is detected", () => {
      mockUseElectronDetection.mockReturnValue({
        ...DEFAULT_ELECTRON_STATE,
        detected: true,
        loading: false,
        port: 19_432,
        checkedAt: Date.now(),
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

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

      const generateButton = screen.getByRole("button", {
        name: GENERATE_API_KEY,
      });
      fireEvent.click(generateButton);

      expect(mockMutate).toHaveBeenCalledWith(
        { name: "ClosedLoop Desktop", scopes: ["read", "write"] },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );
    });

    it("displays the generated API key after successful mutation", async () => {
      mockUseCreatePlatformApiKey.mockReturnValue({
        mutate: makeMockKeyMutate(),
        isPending: false,
      });

      render(<DownloadElectronAppStep onNext={mockOnNext} />);

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

      fireEvent.click(screen.getByRole("button", { name: GENERATE_API_KEY }));

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: CONTINUE_BTN })
        ).not.toBeDisabled();
      });
    });

    it("calls onNext when Skip for now is clicked", () => {
      render(<DownloadElectronAppStep onNext={mockOnNext} />);

      fireEvent.click(screen.getByRole("button", { name: SKIP_FOR_NOW }));

      expect(mockOnNext).toHaveBeenCalledTimes(1);
    });
  });
});
