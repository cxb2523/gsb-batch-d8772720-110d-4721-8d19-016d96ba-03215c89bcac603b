/**
 * Test environment setup shared by every Vitest run.
 */
import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

// DOM assertion matchers (toBeInTheDocument, toHaveTextContent, ...).
expect.extend(matchers);

// Unmount React trees between tests so rendered output never leaks across cases.
afterEach(() => {
  cleanup();
});

/**
 * Minimal browser APIs that jsdom does not implement but Primer React may
 * touch during component tests.
 */

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }

  if (typeof (window as Window & { ResizeObserver?: unknown }).ResizeObserver ===
    "undefined") {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    window.ResizeObserver =
      ResizeObserverStub as unknown as typeof globalThis.ResizeObserver;
  }
}
