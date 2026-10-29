import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../shared/api/api-error";
import { SettingsPanelDataState } from "../../../lib/settings-panel-data-state";
import { GoogleDriveCard } from "../google-drive-card";

type MockIntegrationDisconnectDialogProps = {
  open: boolean;
  onConfirm: () => Promise<void> | void;
  title: string;
  confirmLabel?: string;
};

const mockUseGoogleIntegrationStatus = vi.fn();
const mockUseDisconnectGoogle = vi.fn();
const CONNECT_GOOGLE_LINK_NAME = /connect google drive/i;
const DISCONNECT_BUTTON_NAME = /^disconnect$/i;
const DISCONNECT_DIALOG_NAME = /disconnect google drive/i;
const IMPORT_FROM_FOLDER_BUTTON_NAME = /import from folder/i;

vi.mock("../../../../../google/hooks/use-google-integration", () => ({
  useDisconnectGoogle: () => mockUseDisconnectGoogle(),
  useGoogleIntegrationStatus: () => mockUseGoogleIntegrationStatus(),
}));

vi.mock("../../../../../google/components/google-import-modal", () => ({
  GoogleImportModal: () => null,
}));

vi.mock("../../../components/integration-disconnect-dialog", () => ({
  IntegrationDisconnectDialog: ({
    open,
    onConfirm,
    title,
    confirmLabel = "Disconnect",
  }: MockIntegrationDisconnectDialogProps) =>
    open ? (
      <div aria-label={title} role="dialog">
        <button
          onClick={async () => {
            await onConfirm();
          }}
          type="button"
        >
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

function statusQuery(overrides: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isPending: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function cardState(): string | null {
  const node = document.querySelector("[data-settings-panel-data-state]");
  return node?.getAttribute("data-settings-panel-data-state") ?? null;
}

describe("GoogleDriveCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGoogleIntegrationStatus.mockReturnValue(
      statusQuery({ data: { connected: false, email: null } })
    );
    mockUseDisconnectGoogle.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
  });

  it("shows the loading data-state screen, and no Connect, while the status query is loading", () => {
    mockUseGoogleIntegrationStatus.mockReturnValue(
      statusQuery({ isPending: true })
    );

    render(<GoogleDriveCard />);

    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    expect(cardState()).toBe(SettingsPanelDataState.Loading);
    expect(
      screen.queryByRole("link", { name: CONNECT_GOOGLE_LINK_NAME })
    ).not.toBeInTheDocument();
  });

  it("renders a failed status read as failed, never as Not connected with a Connect link", () => {
    mockUseGoogleIntegrationStatus.mockReturnValue(
      statusQuery({ error: new ApiError("boom", 500) })
    );

    render(<GoogleDriveCard />);

    expect(cardState()).toBe(SettingsPanelDataState.Failed);
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: CONNECT_GOOGLE_LINK_NAME })
    ).not.toBeInTheDocument();
  });

  it("offers Connect as a link to the Google OAuth route when not connected", () => {
    render(<GoogleDriveCard />);

    expect(screen.getByText("Not connected")).toBeInTheDocument();
    // Pinned as a literal: this is the API route the browser is sent to.
    expect(
      screen.getByRole("link", { name: CONNECT_GOOGLE_LINK_NAME })
    ).toHaveAttribute("href", "/api/integrations/google");
  });

  it("shows the connected email, Import, and Disconnect buttons when connected", () => {
    mockUseGoogleIntegrationStatus.mockReturnValue(
      statusQuery({ data: { connected: true, email: "user@example.com" } })
    );

    render(<GoogleDriveCard />);

    expect(screen.getByText("Connected to Google Drive")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: IMPORT_FROM_FOLDER_BUTTON_NAME })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: DISCONNECT_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("disconnects when confirmed in the dialog", async () => {
    mockUseGoogleIntegrationStatus.mockReturnValue(
      statusQuery({ data: { connected: true, email: "user@example.com" } })
    );
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseDisconnectGoogle.mockReturnValue({
      isPending: false,
      mutateAsync,
    });

    render(<GoogleDriveCard />);

    await userEvent.click(
      screen.getByRole("button", { name: DISCONNECT_BUTTON_NAME })
    );
    const dialog = screen.getByRole("dialog", { name: DISCONNECT_DIALOG_NAME });
    await userEvent.click(
      within(dialog).getByRole("button", { name: DISCONNECT_BUTTON_NAME })
    );

    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });
});
