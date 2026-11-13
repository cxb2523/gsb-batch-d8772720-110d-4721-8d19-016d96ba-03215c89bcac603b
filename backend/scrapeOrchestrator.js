/**
 * Scrape Orchestrator (dependency-free)
 * -------------------------------------
 * Pure orchestration for Liya's tiered web scraping pipeline:
 *   Tier 1: Crawl4AI  (markdown/text only, never for screenshots)
 *   Tier 2: Playwright (+ Readability/Turndown)
 *   Tier 3: Jina.ai reader
 *
 * Every run produces an `attempts` array describing, in actual attempt
 * order, which engines were tried, how each one ended, why a failed one
 * failed, and how long it took. The successful engine's payload is
 * returned untouched — this module never rewrites markdown/title/etc.
 *
 * It has zero external dependencies so it can be unit-tested with plain
 * Node (node:test) using injected fake engines — no browser, no network.
 */

'use strict';

// Canonical engine names. Callers should use these constants so the
// recorded attempt names stay stable for consumers and tests.
const ENGINES = {
    CRAWL4AI: 'crawl4ai',
    PLAYWRIGHT: 'playwright',
    JINA: 'jina',
};

const STATUS = {
    SUCCESS: 'success',
    FAILED: 'failed',
};

/** Minimum number of trimmed markdown characters considered valid content. */
const MIN_VALID_CONTENT_LENGTH = 30;

/**
 * Validate a Crawl4AI-style payload. Throws an Error (with a descriptive
 * reason) when the payload is missing or too short to be useful, so the
 * orchestrator records the failure and degrades to the next tier.
 *
 * Rule: markdown/text with a trimmed length of 30 characters or fewer is
 * treated as invalid.
 *
 * @param {object|null|undefined} payload
 * @returns {object} the validated payload
 */
function validateCrawl4AIPayload(payload) {
    const markdown = payload && typeof payload.markdown === 'string' ? payload.markdown : '';
    if (!markdown) {
        throw new Error('Crawl4AI returned no markdown content');
    }
    const trimmedLength = markdown.trim().length;
    if (trimmedLength <= MIN_VALID_CONTENT_LENGTH) {
        throw new Error(
            `Crawl4AI returned content too short to be useful (${trimmedLength} chars, minimum ${MIN_VALID_CONTENT_LENGTH + 1})`
        );
    }
    return payload;
}

/**
 * Build the legacy "all engines failed" result. Shape and wording are kept
 * identical to the previous jinaFallback failure output so existing
 * consumers (and the merged research report) see no content change.
 */
function buildAllFailedResult(url, lastErrorMessage) {
    return {
        title: 'Error',
        markdown: `All extraction methods failed for ${url}. Error: ${lastErrorMessage}`,
        url,
        method: 'all-failed',
    };
}

/**
 * Run an ordered list of scraping engines, degrading through every tier
 * until one succeeds. A failure in any tier never aborts the remaining
 * tiers; every tier's outcome is recorded in `attempts`.
 *
 * @param {Array<{name: string, run: Function}>} engines
 *   Ordered engine descriptors. `run()` receives the shared context and
 *   must return a result object on success or throw on failure.
 * @param {object} [options]
 * @param {string} [options.url] The URL being scraped (for failure result).
 * @param {Function} [options.validate] Optional validator applied to each
 *   successful payload; throwing rejects the attempt and continues.
 * @param {Function} [options.buildFailure] Custom all-failed result factory.
 *   Receives (url, lastErrorMessage, attempts). Defaults to the legacy
 *   all-failed shape.
 * @returns {Promise<object>}
 *   The first successful engine's result with an `attempts` array added,
 *   or an all-failed result (also with the full `attempts` array).
 */
async function runScrapePipeline(engines, options = {}) {
    const {
        url = '',
        validate = null,
        buildFailure = buildAllFailedResult,
    } = options;

    const attempts = [];
    let lastErrorMessage = 'No scraping engines were available';

    for (const engine of engines) {
        const startedAt = Date.now();
        try {
            let payload = await engine.run();
            if (typeof validate === 'function') {
                payload = validate(engine.name, payload);
            }
            attempts.push({
                engine: engine.name,
                status: STATUS.SUCCESS,
                error: null,
                durationMs: Date.now() - startedAt,
            });
            // The successful payload is returned as-is apart from the
            // appended attempts metadata; content fields are untouched.
            return { ...payload, attempts };
        } catch (err) {
            lastErrorMessage = (err && err.message) ? err.message : String(err);
            attempts.push({
                engine: engine.name,
                status: STATUS.FAILED,
                error: lastErrorMessage,
                durationMs: Date.now() - startedAt,
            });
            // Intentional fall-through: try the next tier.
        }
    }

    const failureResult = buildFailure(url, lastErrorMessage, attempts);
    return { ...failureResult, attempts };
}

/**
 * Pure deep-research report merger. Replicates the exact report text format
 * produced by the previous deepResearch() implementation while exposing
 * each source's per-tier `attempts` in the returned sources array.
 *
 * @param {string} query
 * @param {Array<object>} items Normalized per-source results. Each item may
 *   include: searchTitle, title, url, method, charCount, markdown,
 *   screenshotPath, attempts.
 * @returns {{report: string, sources: Array<object>, totalChars: number}}
 */
function mergeDeepResearchResults(query, items) {
    let mergedReport = `# Deep Research: ${query}\n\n`;
    const sources = [];
    let totalChars = 0;

    items.forEach((data, i) => {
        sources.push({
            title: data.searchTitle || data.title || 'Source',
            url: data.url,
            method: data.method,
            charCount: data.charCount || 0,
            screenshotPath: data.screenshotPath || '',
            attempts: Array.isArray(data.attempts) ? data.attempts : [],
        });

        mergedReport += `---\n\n## Source ${i + 1}: ${data.searchTitle || data.title}\n`;
        mergedReport += `> URL: ${data.url}\n`;
        mergedReport += `> Extraction method: ${data.method}\n\n`;

        if (data.screenshotPath) {
            mergedReport += `![Screenshot of ${data.title}](${data.screenshotPath})\n\n---\n\n`;
        }

        mergedReport += data.markdown + '\n\n';
        totalChars += (data.charCount || data.markdown?.length || 0);
    });

    return { report: mergedReport, sources, totalChars };
}

module.exports = {
    ENGINES,
    STATUS,
    MIN_VALID_CONTENT_LENGTH,
    validateCrawl4AIPayload,
    buildAllFailedResult,
    runScrapePipeline,
    mergeDeepResearchResults,
};
