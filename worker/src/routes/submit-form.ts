import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { validateUrl } from "../lib/validate-url.js";
import {
  withBrowser,
  BlockedNavigationError,
  BrowserBindingUnavailable,
  performActionAndTrackNavigation,
  toBaseBody,
} from "../lib/puppeteer.js";
import {
  assertInteractionOutputSize,
  boundedInteractionErrorMessage,
  InteractionOutputLimitError,
} from "../lib/output-limit.js";

type FieldStatus = "filled" | "failed";

type FieldResult = {
  selector: string;
  status: FieldStatus;
  error?: string;
};

type SubmissionResult = {
  attempted: boolean;
  trigger?: "submit_selector" | "first_form";
  navigation_observed: boolean;
  error?: string;
};

type FormOutcome = {
  fields: FieldResult[];
  submission: SubmissionResult;
  url?: string;
  title?: string;
  content?: string;
};

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  if (!body.url || typeof body.url !== "string") {
    return c.json({ error: "Missing required field: url", status: 400 }, 400);
  }

  const urlCheck = validateUrl(body.url as string);
  if (!urlCheck.valid) {
    return c.json({ error: urlCheck.error, status: 400 }, 400);
  }

  if (!body.fields || typeof body.fields !== "object" || Array.isArray(body.fields)) {
    return c.json({ error: "Missing required field: fields (object mapping selector → value)", status: 400 }, 400);
  }

  if (body.continue_on_error !== undefined && typeof body.continue_on_error !== "boolean") {
    return c.json({ error: "continue_on_error must be a boolean", status: 400 }, 400);
  }
  const continueOnError = body.continue_on_error === true;

  const fields = body.fields as Record<string, unknown>;
  const submitSelector = body.submit_selector;
  if (submitSelector !== undefined && (
    typeof submitSelector !== "string" || submitSelector.trim().length === 0
  )) {
    return c.json({ error: "submit_selector must be a non-empty string", status: 400 }, 400);
  }

  // Validate fields count
  const fieldEntries = Object.entries(fields);
  if (fieldEntries.length > 50) {
    return c.json({ error: "fields exceeds 50 entry limit", status: 400 }, 400);
  }

  // Validate selector lengths and value types
  for (const [selector, value] of fieldEntries) {
    if (selector.trim().length === 0) {
      return c.json({ error: "Field selector must be a non-empty string", status: 400 }, 400);
    }
    if (selector.length > 500) {
      return c.json({ error: "Field selector exceeds 500 character limit", status: 400 }, 400);
    }
    if (typeof value !== "string") {
      return c.json({ error: `Field value for "${selector}" must be a string`, status: 400 }, 400);
    }
    if ((value as string).length > 10_000) {
      return c.json({ error: `Field value for "${selector}" exceeds 10000 character limit`, status: 400 }, 400);
    }
  }
  if (submitSelector && submitSelector.length > 500) {
    return c.json({ error: "Submit selector exceeds 500 character limit", status: 400 }, 400);
  }

  try {
    const { httpStatus, outcome } = await withBrowser(
      c.env,
      toBaseBody(body),
      async ({ page }): Promise<{ httpStatus: number; outcome: FormOutcome }> => {
        const fieldResults: FieldResult[] = [];
        let aborted = false;

        // Fill each field independently so a single bad selector is reported
        // without hiding the outcome of the remaining fields.
        for (const [selector, value] of fieldEntries) {
          if (aborted) {
            fieldResults.push({
              selector,
              status: "failed",
              error: "Skipped after an earlier field failure",
            });
            continue;
          }
          try {
            await page.click(selector, { clickCount: 3 });
            await page.keyboard.press("Backspace");
            await page.type(selector, value as string);
            fieldResults.push({ selector, status: "filled" });
          } catch (err) {
            fieldResults.push({
              selector,
              status: "failed",
              error: boundedInteractionErrorMessage(err, "Failed to fill field"),
            });
            // Default semantics: stop at the first failure. With
            // continue_on_error=true, keep attempting the remaining fields.
            if (!continueOnError) aborted = true;
          }
        }

        const filledCount = fieldResults.filter((entry) => entry.status === "filled").length;
        const submission: SubmissionResult = { attempted: false, navigation_observed: false };

        // Never submit when no field could be filled: an empty submission
        // would hide the fact that every fill attempt failed.
        if (filledCount === 0) {
          return {
            httpStatus: 500,
            outcome: { fields: fieldResults, submission },
          };
        }

        // Default stop-on-first-failure semantics: an aborted run does not
        // submit a partially filled form.
        if (aborted) {
          submission.error = "Submission skipped because a field failed";
          return {
            httpStatus: 200,
            outcome: { fields: fieldResults, submission },
          };
        }

        const urlBeforeSubmit = page.url();
        try {
          if (submitSelector) {
            submission.trigger = "submit_selector";
            submission.attempted = true;
            const { navigationObserved } = await performActionAndTrackNavigation(
              page,
              () => page.click(submitSelector),
              10_000,
            );
            submission.navigation_observed = navigationObserved;
          } else {
            submission.trigger = "first_form";
            submission.attempted = true;
            const { result, navigationObserved } = await performActionAndTrackNavigation(
              page,
              () =>
                page.evaluate(
                  `(() => {
                const form = document.querySelector("form");
                if (!(form instanceof HTMLFormElement)) {
                  return { ok: false, error: "No form found on page" };
                }

                if (typeof form.requestSubmit === "function") {
                  form.requestSubmit();
                  return { ok: true, method: "requestSubmit" };
                }

                const submitter = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
                if (submitter instanceof HTMLElement) {
                  submitter.click();
                  return { ok: true, method: "click" };
                }

                return { ok: false, error: "Form submission requires a submit control" };
              })()`
                ),
              10_000,
            );
            submission.navigation_observed = navigationObserved;

            if (
              !result ||
              typeof result !== "object" ||
              (result as { ok?: boolean }).ok !== true
            ) {
              const message =
                typeof result === "object" &&
                result !== null &&
                "error" in result &&
                typeof result.error === "string"
                  ? result.error
                  : "Form submission failed";
              throw new Error(message);
            }
          }
        } catch (err) {
          submission.navigation_observed = page.url() !== urlBeforeSubmit;
          submission.error = boundedInteractionErrorMessage(err, "Form submission failed");
        }

        const outcome: FormOutcome = {
          fields: fieldResults,
          submission,
          url: page.url(),
          title: await page.title(),
          content: await page.content(),
        };
        // Enforce the interaction output ceiling on the whole envelope;
        // an oversized response maps to 502 via the outer error mapping.
        return { httpStatus: 200, outcome: assertInteractionOutputSize(outcome) };
      }
    );

    if (httpStatus >= 400) {
      return c.json(
        {
          error: "All form fields failed and the form was not submitted",
          status: httpStatus,
          fields: outcome.fields,
          submission: outcome.submission,
        },
        httpStatus as 500,
      );
    }
    return c.json(outcome);
  } catch (err) {
    if (err instanceof BrowserBindingUnavailable) {
      return c.json({ error: boundedInteractionErrorMessage(err, "Browser unavailable"), status: 501 }, 501);
    }
    if (err instanceof BlockedNavigationError) {
      return c.json({ error: boundedInteractionErrorMessage(err, "Navigation blocked"), status: 400 }, 400);
    }
    if (err instanceof InteractionOutputLimitError) {
      return c.json({ error: boundedInteractionErrorMessage(err, "Interaction output failed"), status: 502 }, 502);
    }
    const message = boundedInteractionErrorMessage(err, "Form submission failed");
    return c.json({ error: message, status: 500 }, 500);
  }
});

export default app;
