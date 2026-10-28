/**
 * ISS-10903: the per-gateway-profile sandbox field (FEA-4005 / ISS-4577) and
 * the three helpers it is built from. The field is the one place a sandbox path
 * is both SHOWN as invalid and GATES a Save, so its two predicates have to
 * agree about what "invalid" means — and each has a deliberate "unknown is not
 * invalid" arm (`exists: undefined`, an inspection that has not settled onto the
 * current value) that no lying-UI rule lets us collapse into the error case.
 *
 * Every case here drives the real exported symbol and asserts the value or the
 * rendered sentence, never that a mock was reached. The two predicates are
 * asserted in BOTH directions — a helper that returned a constant would fail
 * these as loudly as one that returned nothing.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SANDBOX_MISSING_DIRECTORY_MESSAGE,
  SANDBOX_RISKY_ROOT_MESSAGE,
} from "../../../../shared/sandbox-messages.js";
import type { SandboxInspectResult } from "../../../types/desktop-api";
import type { GatewayProfileRowData } from "../gateway-profile-row";
import {
  getSandboxFieldFeedback,
  isSandboxValueSettledInvalid,
  ProfileSandboxField,
} from "../gateway-profile-sandbox-field";
import { GatewayProfilesCard } from "../gateway-profiles-card";

const GIT_REPO_HINT_RE = /itself a git repo/i;
const SANDBOX_LABEL = "Sandbox Directory";
const BROWSE_LABEL = "Browse";
const PATH = "/workspace/projects";
const GLOBAL_SANDBOX = "/workspace/global";
/** The field debounces its inspect probe by 300ms; advance past it. */
const DEBOUNCE_MS = 300;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  cleanup();
  // Unconditional restore: a case that throws between install and teardown must
  // not leak a frozen clock or a stub API into the rest of the file.
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("getSandboxFieldFeedback", () => {
  it("says nothing for a blank or whitespace-only value, even with a risky inspection in hand", () => {
    expect(
      getSandboxFieldFeedback("", inspection({ isRisky: true }))
    ).toBeNull();
    expect(
      getSandboxFieldFeedback("   ", inspection({ isRisky: true }))
    ).toBeNull();
  });

  it("says nothing for a value whose inspection reports a clean directory", () => {
    expect(getSandboxFieldFeedback(PATH, inspection())).toBeNull();
  });

  it("reports the shared risky-root copy, and risky outranks a missing directory", () => {
    expect(
      getSandboxFieldFeedback(PATH, inspection({ isRisky: true }))
    ).toEqual({
      message: SANDBOX_RISKY_ROOT_MESSAGE,
      tone: expect.any(String),
    });
    // Both flags set: the risky sentence is the one that renders.
    expect(
      getSandboxFieldFeedback(
        PATH,
        inspection({ isRisky: true, exists: false })
      )?.message
    ).toBe(SANDBOX_RISKY_ROOT_MESSAGE);
  });

  it("reports a KNOWN-missing directory but stays silent when existence is unknown", () => {
    expect(
      getSandboxFieldFeedback(PATH, inspection({ exists: false }))?.message
    ).toBe(SANDBOX_MISSING_DIRECTORY_MESSAGE);
    // `undefined` is a TCC-protected / older-build folder, not a missing one.
    expect(
      getSandboxFieldFeedback(PATH, inspection({ exists: undefined }))
    ).toBeNull();
  });

  it("hints about a git repo only once the error arms have been ruled out", () => {
    expect(
      getSandboxFieldFeedback(PATH, inspection({ isGitRepo: true }))?.message
    ).toMatch(GIT_REPO_HINT_RE);
    // A git repo that is ALSO missing reports the missing error, not the hint.
    expect(
      getSandboxFieldFeedback(
        PATH,
        inspection({ isGitRepo: true, exists: false })
      )?.message
    ).toBe(SANDBOX_MISSING_DIRECTORY_MESSAGE);
  });

  it("gives the git-repo hint a different tone from the two error sentences", () => {
    const risky = getSandboxFieldFeedback(PATH, inspection({ isRisky: true }));
    const hint = getSandboxFieldFeedback(PATH, inspection({ isGitRepo: true }));

    expect(hint?.tone).not.toBe(risky?.tone);
  });

  it("says nothing when there is no inspection at all", () => {
    expect(getSandboxFieldFeedback(PATH, null)).toBeNull();
  });
});

describe("isSandboxValueSettledInvalid", () => {
  it("treats blank as valid — blank means inherit the global sandbox", () => {
    expect(
      isSandboxValueSettledInvalid("", inspection({ isRisky: true }))
    ).toBe(false);
    expect(
      isSandboxValueSettledInvalid("   ", inspection({ isRisky: true }))
    ).toBe(false);
  });

  it("refuses to judge an inspection that describes a different path", () => {
    // The user has typed on; the settled inspection belongs to the old value.
    expect(
      isSandboxValueSettledInvalid(
        "/workspace/other",
        inspection({ path: PATH, isRisky: true })
      )
    ).toBe(false);
  });

  it("matches the value by its TRIMMED form, so surrounding space still settles", () => {
    expect(
      isSandboxValueSettledInvalid(`  ${PATH}  `, inspection({ isRisky: true }))
    ).toBe(true);
  });

  it("is invalid for a settled risky root and for a settled missing directory", () => {
    expect(
      isSandboxValueSettledInvalid(PATH, inspection({ isRisky: true }))
    ).toBe(true);
    expect(
      isSandboxValueSettledInvalid(PATH, inspection({ exists: false }))
    ).toBe(true);
  });

  it("is valid for a clean directory, for unknown existence, and with no inspection", () => {
    expect(isSandboxValueSettledInvalid(PATH, inspection())).toBe(false);
    expect(
      isSandboxValueSettledInvalid(PATH, inspection({ exists: undefined }))
    ).toBe(false);
    expect(isSandboxValueSettledInvalid(PATH, null)).toBe(false);
  });
});

describe("ProfileSandboxField", () => {
  it("shows the global sandbox as the inherit placeholder while the value is blank", () => {
    installDesktopApi();
    render(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={vi.fn()}
        value=""
      />
    );

    expect(
      screen.getByLabelText(SANDBOX_LABEL).getAttribute("placeholder")
    ).toBe(GLOBAL_SANDBOX);
  });

  it("falls back to an example path when there is no global sandbox to inherit", () => {
    installDesktopApi();
    render(
      <ProfileSandboxField globalSandbox="" onChange={vi.fn()} value="" />
    );

    expect(
      screen.getByLabelText(SANDBOX_LABEL).getAttribute("placeholder")
    ).not.toBe("");
  });

  it("reports the typed value up on every edit", () => {
    installDesktopApi();
    const onChange = vi.fn();
    render(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={onChange}
        value=""
      />
    );

    fireEvent.change(screen.getByLabelText(SANDBOX_LABEL), {
      target: { value: PATH },
    });

    expect(onChange).toHaveBeenCalledWith(PATH);
  });

  it("fires onEnter for Enter and leaves other keys alone", () => {
    installDesktopApi();
    const onEnter = vi.fn();
    render(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={vi.fn()}
        onEnter={onEnter}
        value={PATH}
      />
    );
    const input = screen.getByLabelText(SANDBOX_LABEL);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onEnter).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("renders the risky sentence only after the debounced probe settles", async () => {
    vi.useFakeTimers();
    installDesktopApi({
      inspectSandboxPath: vi.fn(async () =>
        inspection({ path: PATH, isRisky: true })
      ),
    });
    render(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={vi.fn()}
        value={PATH}
      />
    );

    // Before the debounce elapses the field has nothing to say.
    expect(screen.queryByText(SANDBOX_RISKY_ROOT_MESSAGE)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(screen.getByText(SANDBOX_RISKY_ROOT_MESSAGE)).toBeTruthy();
  });

  it("never probes a blank value, and clears a previous inspection when cleared", async () => {
    vi.useFakeTimers();
    const inspectSandboxPath = vi.fn(async () =>
      inspection({ path: PATH, exists: false })
    );
    installDesktopApi({ inspectSandboxPath });
    const { rerender } = render(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={vi.fn()}
        value={PATH}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    expect(screen.getByText(SANDBOX_MISSING_DIRECTORY_MESSAGE)).toBeTruthy();

    rerender(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={vi.fn()}
        value="   "
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(screen.queryByText(SANDBOX_MISSING_DIRECTORY_MESSAGE)).toBeNull();
    expect(inspectSandboxPath).toHaveBeenCalledTimes(1);
  });

  it("debounces a fast edit into a single probe of the settled value", async () => {
    vi.useFakeTimers();
    const inspectSandboxPath = vi.fn(async () => inspection({ path: PATH }));
    installDesktopApi({ inspectSandboxPath });
    const { rerender } = render(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={vi.fn()}
        value="/work"
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100);
    });
    rerender(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={vi.fn()}
        value={PATH}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(inspectSandboxPath).toHaveBeenCalledTimes(1);
    expect(inspectSandboxPath).toHaveBeenCalledWith(PATH);
  });

  it("stays silent when the probe rejects rather than reporting a failure as invalid", async () => {
    vi.useFakeTimers();
    installDesktopApi({
      inspectSandboxPath: vi.fn(() =>
        Promise.reject(new Error("probe failed"))
      ),
    });
    const onValidityChange = vi.fn();
    render(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={vi.fn()}
        onValidityChange={onValidityChange}
        value={PATH}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(screen.queryByText(SANDBOX_RISKY_ROOT_MESSAGE)).toBeNull();
    expect(onValidityChange).not.toHaveBeenCalledWith(true);
  });

  it("reports validity up so the owning Save can gate on it", async () => {
    vi.useFakeTimers();
    installDesktopApi({
      inspectSandboxPath: vi.fn(async () =>
        inspection({ path: PATH, isRisky: true })
      ),
    });
    const onValidityChange = vi.fn();
    render(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={vi.fn()}
        onValidityChange={onValidityChange}
        value={PATH}
      />
    );

    // Blank/unsettled reports valid first; only the settled risky probe flips it.
    expect(onValidityChange).toHaveBeenCalledWith(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(onValidityChange).toHaveBeenCalledWith(true);
  });

  it("writes the picked directory back, and keeps the value when the picker is cancelled", async () => {
    const onChange = vi.fn();
    const pickSandboxDirectory = vi
      .fn()
      .mockResolvedValueOnce(inspection({ path: "/picked" }))
      .mockResolvedValueOnce(null);
    installDesktopApi({ pickSandboxDirectory });
    render(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={onChange}
        value=""
      />
    );

    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: BROWSE_LABEL }));
    });
    expect(onChange).toHaveBeenCalledWith("/picked");

    // A cancelled picker resolves null and must not clear the field.
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: BROWSE_LABEL }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("swallows a picker failure rather than surfacing it as a field error", async () => {
    const onChange = vi.fn();
    installDesktopApi({
      pickSandboxDirectory: vi.fn(() =>
        Promise.reject(new Error("picker exploded"))
      ),
    });
    render(
      <ProfileSandboxField
        globalSandbox={GLOBAL_SANDBOX}
        onChange={onChange}
        value=""
      />
    );

    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: BROWSE_LABEL }));
    });

    expect(onChange).not.toHaveBeenCalled();
  });
});

// ISS-10903 (whitlockk review): `onValidityChange` firing `true` proves nothing
// about the two Save buttons that are supposed to act on it — the card's own
// test fixture always resolves `inspectSandboxPath` to `null`, so neither Save
// predicate is ever driven by a settled result there. These cases render the
// real GatewayProfilesCard, settle a risky/missing inspection through it, and
// assert the Save button itself — not the callback — stays blocked.
describe("GatewayProfilesCard — sandbox validity gates Save", () => {
  it("blocks the Selected Profile Save once its own sandbox settles risky, even though every other field is complete", async () => {
    vi.useFakeTimers();
    installDesktopApi({
      inspectSandboxPath: vi.fn(async () =>
        inspection({ path: PATH, isRisky: true })
      ),
    });
    render(<GatewayProfilesCard settings={cardSettings(PATH)} />);
    const saveButton = () =>
      screen.getByRole("button", { name: SAVE_LABEL }) as HTMLButtonElement;

    // Name/relay/API/app URI are all filled by the fixture; only the
    // debounced sandbox probe is still pending.
    expect(saveButton().disabled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(saveButton().disabled).toBe(true);
  });

  it("blocks the new-profile dialog's Save once its sandbox settles as a known-missing directory, even though every other field is complete", async () => {
    vi.useFakeTimers();
    installDesktopApi({
      inspectSandboxPath: vi.fn(async () =>
        inspection({ path: PATH, exists: false })
      ),
    });
    render(<GatewayProfilesCard settings={cardSettings()} />);

    fireEvent.click(screen.getByRole("button", { name: SAVE_PROFILE_LABEL }));
    fireEvent.change(dialogScope().getByLabelText(PROFILE_NAME_LABEL), {
      target: { value: "EU" },
    });
    fireEvent.change(dialogScope().getByLabelText(SANDBOX_LABEL), {
      target: { value: PATH },
    });
    const saveProfileButton = () =>
      dialogScope().getByRole("button", {
        name: SAVE_PROFILE_LABEL,
      }) as HTMLButtonElement;

    // Relay/API/app URI are seeded from global settings and the name was just
    // filled in; only the debounced sandbox probe is still pending.
    expect(saveProfileButton().disabled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(saveProfileButton().disabled).toBe(true);
  });
});

/** A settled inspection for {@link PATH}, overridable per case. */
function inspection(
  overrides: Partial<SandboxInspectResult> = {}
): SandboxInspectResult {
  return {
    path: PATH,
    isGitRepo: false,
    suggestedPath: undefined,
    isRisky: false,
    exists: true,
    ...overrides,
  } as SandboxInspectResult;
}

function installDesktopApi(
  overrides: Record<string, ReturnType<typeof vi.fn>> = {}
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      inspectSandboxPath: vi.fn(async () => null),
      pickSandboxDirectory: vi.fn(async () => null),
      ...overrides,
    },
  });
}

const SAVE_LABEL = "Save";
const SAVE_PROFILE_LABEL = "Save Profile";
const PROFILE_NAME_LABEL = "Profile Name";

/**
 * Settings for a single-profile GatewayProfilesCard. Every field the two Save
 * predicates check (`isProfileFormComplete`) is pre-filled so the sandbox is
 * the only thing left to settle. `profileSandbox` seeds the SAVED profile's
 * own sandbox value (what the Selected Profile editor renders on mount); the
 * New-profile dialog always starts with a blank sandbox regardless.
 */
function cardSettings(profileSandbox?: string): Record<string, unknown> {
  const profile: GatewayProfileRowData = {
    apiOrigin: "https://api.prod.test",
    id: "profile-1",
    name: "Production",
    relayOrigin: "https://relay.prod.test",
    sandboxBaseDirectory: profileSandbox,
    webAppOrigin: "https://app.prod.test",
  };
  return {
    activeConfigId: profile.id,
    apiOrigin: profile.apiOrigin,
    relayOrigin: profile.relayOrigin,
    sandboxBaseDirectory: GLOBAL_SANDBOX,
    savedConfigs: [profile],
    webAppOrigin: profile.webAppOrigin,
  };
}

/** Scope to the New-profile dialog, which renders its own "Save Profile" button alongside the trigger of the same name. */
function dialogScope() {
  return within(screen.getByRole("dialog"));
}
