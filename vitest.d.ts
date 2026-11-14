/**
 * Registers jest-dom's DOM matchers (toBeInTheDocument, toHaveTextContent, ...)
 * on Vitest's Assertion type. The runtime matchers are extended in
 * vitest.setup.ts; this file supplies the compile-time augmentation.
 */
import "@testing-library/jest-dom/vitest";
