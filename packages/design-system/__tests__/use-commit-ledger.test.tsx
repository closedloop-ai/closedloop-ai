import { useCommitLedger } from "@closedloop-ai/design-system/components/ui/use-commit-ledger";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("useCommitLedger", () => {
  it("keeps an optimistic echo subordinate to the pending attempt it echoes", async () => {
    let refuse: ((reason: unknown) => void) | undefined;
    const write = new Promise<void>((_resolve, reject) => {
      refuse = reject;
    });
    const onResolved = vi.fn();
    const onSettled = vi.fn();
    const { result } = renderHook(() => useCommitLedger("confirmed"));

    act(() => {
      result.current.submit("attempted", () => write, onResolved, onSettled);
      result.current.reset("attempted");
    });

    expect(result.current.current()).toBe("attempted");

    await act(async () => {
      refuse?.(new Error("refused"));
      await write.catch(() => undefined);
    });

    await waitFor(() =>
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({
          accepted: false,
          authoritative: true,
          submitted: "attempted",
        })
      )
    );
    expect(onResolved).toHaveBeenCalledWith("confirmed");
    expect(result.current.current()).toBe("confirmed");
  });

  it("lets a foreign value after the echo supersede the pending attempt", async () => {
    let refuse: ((reason: unknown) => void) | undefined;
    const write = new Promise<void>((_resolve, reject) => {
      refuse = reject;
    });
    const onResolved = vi.fn();
    const onSettled = vi.fn();
    const { result } = renderHook(() => useCommitLedger("confirmed"));

    act(() => {
      result.current.submit("attempted", () => write, onResolved, onSettled);
      result.current.reset("attempted");
      result.current.reset("someone else's edit");
    });

    await act(async () => {
      refuse?.(new Error("refused"));
      await write.catch(() => undefined);
    });

    await waitFor(() =>
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ accepted: false, authoritative: false })
      )
    );
    expect(result.current.current()).toBe("someone else's edit");
  });

  it("keeps the attempt authoritative when the host rolls back before the refusal settles", async () => {
    let refuse: ((reason: unknown) => void) | undefined;
    const write = new Promise<void>((_resolve, reject) => {
      refuse = reject;
    });
    const onResolved = vi.fn();
    const onSettled = vi.fn();
    const { result } = renderHook(() => useCommitLedger("confirmed"));

    act(() => {
      result.current.submit("attempted", () => write, onResolved, onSettled);
      result.current.reset("attempted");
      result.current.reset("confirmed");
    });

    await act(async () => {
      refuse?.(new Error("refused"));
      await write.catch(() => undefined);
    });

    await waitFor(() =>
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({
          accepted: false,
          authoritative: true,
          submitted: "attempted",
        })
      )
    );
    expect(result.current.current()).toBe("confirmed");
  });
});
