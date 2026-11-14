import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider, BaseStyles } from "@primer/react";
import { PreloadOutcomeNotice } from "@/components/preload-outcome-notice";
import { preloadOutcomeMessage } from "@/lib/preload";

function renderNotice(slot: "primary" | "comparison", outcome: Parameters<typeof PreloadOutcomeNotice>[0]["outcome"]) {
  return render(
    <ThemeProvider colorMode="day">
      <BaseStyles>
        <PreloadOutcomeNotice slot={slot} outcome={outcome} />
      </BaseStyles>
    </ThemeProvider>,
  );
}

describe("PreloadOutcomeNotice", () => {
  it("renders nothing while the slot is unprobed (null)", () => {
    renderNotice("primary", null);
    expect(screen.queryByText(preloadOutcomeMessage("primary", "not_found"))).toBeNull();
  });

  it("renders nothing on success so a loaded report shows no failure messaging", () => {
    renderNotice("primary", "success");
    expect(screen.queryByText(preloadOutcomeMessage("primary", "parse_failed"))).toBeNull();
  });

  it.each([
    "not_found",
    "not_csv",
    "parse_failed",
    "fetch_failed",
  ] as const)("explains the %s outcome in plain language for the primary slot", (outcome) => {
    renderNotice("primary", outcome);
    expect(
      screen.getByText(preloadOutcomeMessage("primary", outcome)),
    ).toBeInTheDocument();
  });

  it("uses slot-specific wording for the comparison slot", () => {
    renderNotice("comparison", "not_found");
    expect(
      screen.getByText(preloadOutcomeMessage("comparison", "not_found")),
    ).toBeInTheDocument();
  });

  it("renders a non-HTML-looking, non-technical message that never mentions a file name", () => {
    renderNotice("primary", "not_csv");
    const message = preloadOutcomeMessage("primary", "not_csv");
    const matches = screen.getAllByText(message);
    expect(matches.length).toBeGreaterThan(0);
    for (const el of matches) {
      expect(el.textContent ?? "").not.toMatch(/content-type|text\/html|status|404/i);
    }
  });
});
