// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useClipboardCopy } from "@/hooks/use-clipboard-copy";

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useClipboardCopy", () => {
  test("starts with copied set to false", () => {
    const { result } = renderHook(() => useClipboardCopy());

    expect(result.current.copied).toBe(false);
  });

  test("copies the text and sets copied to true", async () => {
    const { result } = renderHook(() => useClipboardCopy());
    let ok: boolean | undefined;

    await act(async () => {
      ok = await result.current.copy("hello");
    });

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(result.current.copied).toBe(true);
  });

  test("resets copied after the default 2000 ms", async () => {
    const { result } = renderHook(() => useClipboardCopy());

    await act(async () => {
      await result.current.copy("hello");
    });
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  test("resets copied after a custom timeoutMs", async () => {
    const { result } = renderHook(() => useClipboardCopy({ timeoutMs: 500 }));

    await act(async () => {
      await result.current.copy("hello");
    });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  test("returns false and keeps copied false when the clipboard rejects", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const { result } = renderHook(() => useClipboardCopy());
    let ok: boolean | undefined;

    await act(async () => {
      ok = await result.current.copy("hello");
    });

    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
  });
});
