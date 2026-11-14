// Reproducible, resumable Shopify catalogue scan engine.
//
// This module holds no I/O of its own: the caller injects a `fetcher` that talks to
// hasdata_shopify_products_getProducts and a `sleepImpl` used for backoff. That keeps every
// branching rule (short pages, empty pages, non-Shopify bodies, rate limits) deterministic and
// testable with scripted replies.
//
// Output field names are snake_case to match Shopify's own published fields.

export const PAGE_LIMIT = 250;
export const MAX_ATTEMPTS = 5;
// Wait before attempts 2..5. Strictly increasing, as the retry contract requires.
export const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];
export const SCHEMA_VERSION = 1;

export const OUTCOME = Object.freeze({
    SUCCESS: 'success',
    EMPTY: 'empty',
    NON_SHOPIFY: 'non_shopify',
    RATE_LIMITED: 'rate_limited',
});

// Chinese labels used when rendering the record for a reader; the record itself stays machine-readable.
export const OUTCOME_LABELS = Object.freeze({
    success: '成功',
    empty: '空页',
    non_shopify: '非 Shopify',
    rate_limited: '限流失败',
});

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shopify sends prices as strings ("16.00"). Everything numeric in the record goes through here,
// because a string sort puts "9.00" above "16.00" and still looks like an answer.
export function toNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const trimmed = String(value).trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

// A product is sold out only when it has variants and every one of them reports available === false.
export function isSoldOut(product) {
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    return variants.length > 0 && variants.every((variant) => variant && variant.available === false);
}

// Per-page price statistics across variants (the price never lives on the product).
// compare_at_price === null is the ordinary "not discounted" case and must not count as one;
// a discount additionally requires the compare price to be strictly above the current price.
export function summarizePrices(products) {
    let priceMin = null;
    let priceMax = null;
    let pricedVariants = 0;
    let discountedVariants = 0;

    for (const product of products ?? []) {
        for (const variant of product.variants ?? []) {
            const price = toNumber(variant?.price);
            if (price === null) continue;
            pricedVariants += 1;
            priceMin = priceMin === null ? price : Math.min(priceMin, price);
            priceMax = priceMax === null ? price : Math.max(priceMax, price);

            const compareAt = toNumber(variant?.compare_at_price);
            if (compareAt !== null && compareAt > price) discountedVariants += 1;
        }
    }

    return {
        price_min: priceMin,
        price_max: priceMax,
        priced_variants: pricedVariants,
        discounted_variants: discountedVariants,
    };
}

function mentionsConcurrencyLimit(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.includes('concurrency_limit');
    try {
        return JSON.stringify(value).includes('concurrency_limit');
    } catch {
        return false;
    }
}

// A rate-limit reply is either an HTTP 429 or any body mentioning concurrency_limit. HasData
// answers the free tier with code concurrency_limit inside a 200 streamable-HTTP response, so the
// body has to be inspected, not just the status.
export function isRateLimitedReply(reply) {
    if (!reply) return false;
    if (reply.status === 429) return true;
    return mentionsConcurrencyLimit(reply.payload) || mentionsConcurrencyLimit(reply.raw);
}

async function fetchPageWithRetry(fetcher, args, options) {
    const { sleepImpl, maxAttempts, backoffMs, onAttempt } = options;
    const sleptMs = [];
    let reply = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        onAttempt?.({ ...args, attempt });
        reply = await fetcher(args);
        if (!isRateLimitedReply(reply)) return { reply, attempts: attempt, sleptMs };
        if (attempt < maxAttempts) {
            const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
            sleptMs.push(delay);
            await sleepImpl(delay);
        }
    }

    return { reply, attempts: maxAttempts, sleptMs, rateLimited: true };
}

function emptyOutcomeCounts() {
    return { success: 0, empty: 0, non_shopify: 0, rate_limited: 0 };
}

// Scan one collection from `startPage` (1 for a fresh run). Prior successful page records and
// their running total are passed in when resuming a collection that previously hit a rate limit.
export async function scanCollection(handle, fetcher, options = {}) {
    const {
        sleepImpl = realSleep,
        maxAttempts = MAX_ATTEMPTS,
        backoffMs = DEFAULT_BACKOFF_MS,
        startPage = 1,
        initialCumulative = 0,
        priorPageRecords = [],
        priorSoldOut = [],
    } = options;

    const pageRecords = [...priorPageRecords];
    const soldOutProducts = [...priorSoldOut];
    const outcomeCounts = emptyOutcomeCounts();

    let page = startPage;
    let cumulative = initialCumulative;
    let collectionPriceMin = null;
    let collectionPriceMax = null;
    let discountedVariants = 0;
    let failureReason = null;
    let resumeFromPage = null;
    let resumeHint = null;

    while (true) {
        const args = { collection: handle, limit: PAGE_LIMIT, page };
        const { reply, attempts, rateLimited } = await fetchPageWithRetry(fetcher, args, {
            sleepImpl,
            maxAttempts,
            backoffMs,
        });

        if (rateLimited) {
            const reason = `rate limited after ${maxAttempts} attempts (429 / concurrency_limit)`;
            pageRecords.push({
                collection: handle,
                page,
                outcome: OUTCOME.RATE_LIMITED,
                products_on_page: 0,
                cumulative_products: cumulative,
                attempts,
                failure_reason: reason,
            });
            outcomeCounts.rate_limited += 1;
            failureReason = reason;
            resumeFromPage = page;
            resumeHint = `resume collection ${handle} from page ${page} once the rate limit clears`;
            break;
        }

        const payload = reply?.payload;

        if (payload && Array.isArray(payload.products)) {
            const products = payload.products;

            if (products.length === 0) {
                // An empty page is a normal stop signal (including a wholly empty collection),
                // not a failure.
                pageRecords.push({
                    collection: handle,
                    page,
                    outcome: OUTCOME.EMPTY,
                    products_on_page: 0,
                    cumulative_products: cumulative,
                    attempts,
                });
                outcomeCounts.empty += 1;
                break;
            }

            const stats = summarizePrices(products);
            cumulative += products.length;
            pageRecords.push({
                collection: handle,
                page,
                outcome: OUTCOME.SUCCESS,
                products_on_page: products.length,
                cumulative_products: cumulative,
                attempts,
                price_min: stats.price_min,
                price_max: stats.price_max,
                discounted_variants: stats.discounted_variants,
            });
            outcomeCounts.success += 1;

            if (stats.price_min !== null) {
                collectionPriceMin =
                    collectionPriceMin === null ? stats.price_min : Math.min(collectionPriceMin, stats.price_min);
            }
            if (stats.price_max !== null) {
                collectionPriceMax =
                    collectionPriceMax === null ? stats.price_max : Math.max(collectionPriceMax, stats.price_max);
            }
            discountedVariants += stats.discounted_variants;

            for (const product of products) {
                if (isSoldOut(product)) {
                    soldOutProducts.push({
                        collection: handle,
                        handle: product.handle,
                        title: product.title,
                        vendor: product.vendor,
                        product_type: product.product_type,
                    });
                }
            }

            // There is no pagination block: a short (or empty) page is the only stop signal.
            if (products.length < PAGE_LIMIT) break;
            page += 1;
            continue;
        }

        // No products array. A classic non-Shopify reply carries an `error` string; an unexpected
        // shape is recorded the same way so the run never has to guess.
        const errorMessage =
            payload && typeof payload.error === 'string'
                ? payload.error
                : 'response carried neither a products array nor an error string';
        pageRecords.push({
            collection: handle,
            page,
            outcome: OUTCOME.NON_SHOPIFY,
            products_on_page: 0,
            cumulative_products: cumulative,
            attempts,
            error: errorMessage,
        });
        outcomeCounts.non_shopify += 1;
        failureReason = `non-Shopify response: ${errorMessage}`;
        resumeFromPage = 1;
        resumeHint = `retry collection ${handle} against its https://<shop>.myshopify.com address`;
        break;
    }

    const summary = {
        collection: handle,
        status: failureReason === null ? 'complete' : 'failed',
        pages: pageRecords.length,
        successful_pages: outcomeCounts.success,
        product_count: cumulative,
        price_min: collectionPriceMin,
        price_max: collectionPriceMax,
        discounted_variants: discountedVariants,
        outcome_counts: outcomeCounts,
        failure_reason: failureReason,
        needs_resume: failureReason !== null,
        resume_from_page: resumeFromPage,
        resume_hint: resumeHint,
    };

    return { summary, pageRecords, soldOutProducts };
}

function buildRecord({ url, startedAt, finishedAt, collectionSummaries, pageOutcomes, soldOutProducts }) {
    const totals = {
        collections: collectionSummaries.length,
        collections_completed: collectionSummaries.filter((s) => s.status === 'complete').length,
        collections_failed: collectionSummaries.filter((s) => s.status === 'failed').length,
        pages: pageOutcomes.length,
        successful_pages: pageOutcomes.filter((r) => r.outcome === OUTCOME.SUCCESS).length,
        empty_pages: pageOutcomes.filter((r) => r.outcome === OUTCOME.EMPTY).length,
        non_shopify_pages: pageOutcomes.filter((r) => r.outcome === OUTCOME.NON_SHOPIFY).length,
        rate_limited_pages: pageOutcomes.filter((r) => r.outcome === OUTCOME.RATE_LIMITED).length,
        products: collectionSummaries.reduce((total, s) => total + s.product_count, 0),
        sold_out_products: soldOutProducts.length,
    };

    const collectionsNeedingResume = collectionSummaries
        .filter((s) => s.needs_resume)
        .map((s) => ({
            collection: s.collection,
            reason: s.failure_reason,
            resume_from_page: s.resume_from_page,
            resume_hint: s.resume_hint,
        }));

    return {
        schema_version: SCHEMA_VERSION,
        url,
        limit: PAGE_LIMIT,
        started_at: startedAt,
        finished_at: finishedAt,
        collections: collectionSummaries,
        page_outcomes: pageOutcomes,
        sold_out_products: soldOutProducts,
        totals,
        collections_needing_resume: collectionsNeedingResume,
    };
}

// Scan every collection in order, one request at a time. A failed collection never aborts the
// round: it is recorded and the scan moves on. `priorRecord` is a previously checkpointed record
// and makes the run resumable; `onCollectionComplete` receives a snapshot after each collection.
export async function scanStore(options) {
    const {
        url,
        collections,
        fetcher,
        sleepImpl = realSleep,
        now = () => new Date().toISOString(),
        maxAttempts = MAX_ATTEMPTS,
        backoffMs = DEFAULT_BACKOFF_MS,
        priorRecord = null,
        onCollectionComplete = null,
    } = options;

    if (!url) throw new Error('scanStore requires a store url');
    if (typeof fetcher !== 'function') throw new Error('scanStore requires a fetcher function');

    const handles = (collections ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.handle));
    const sameUrl = priorRecord?.url === url;
    const startedAt = sameUrl && priorRecord.started_at ? priorRecord.started_at : now();

    const priorSummaries = new Map();
    for (const summary of priorRecord?.collections ?? []) {
        priorSummaries.set(summary.collection, summary);
    }

    // Records for collections that are no longer in the current list are preserved verbatim.
    const pageOutcomes = (priorRecord?.page_outcomes ?? []).filter((r) => !handles.includes(r.collection));
    const soldOutProducts = (priorRecord?.sold_out_products ?? []).filter((p) => !handles.includes(p.collection));
    const collectionSummaries = [];

    const checkpoint = (finishedAt) =>
        buildRecord({
            url,
            startedAt,
            finishedAt,
            collectionSummaries,
            pageOutcomes,
            soldOutProducts,
        });

    for (const handle of handles) {
        const prior = priorSummaries.get(handle);

        if (prior?.status === 'complete') {
            // Already fully scanned in the checkpointed run: reuse every record, spend no credits.
            collectionSummaries.push(prior);
            pageOutcomes.push(...(priorRecord.page_outcomes ?? []).filter((r) => r.collection === handle));
            soldOutProducts.push(...(priorRecord.sold_out_products ?? []).filter((p) => p.collection === handle));
            await onCollectionComplete?.(checkpoint(null), handle);
            continue;
        }

        let startPage = 1;
        let initialCumulative = 0;
        let priorPageRecords = [];
        let priorSoldOut = [];

        if (prior && sameUrl) {
            // Resume after a rate-limit failure: keep the successful pages and continue at the
            // failed page. A non-Shopify failure resumes at page 1 (typically against a new URL).
            priorPageRecords = (priorRecord.page_outcomes ?? []).filter(
                (r) => r.collection === handle && r.outcome === OUTCOME.SUCCESS
            );
            priorSoldOut = (priorRecord.sold_out_products ?? []).filter((p) => p.collection === handle);
            startPage = prior.resume_from_page ?? 1;
            initialCumulative = priorPageRecords.reduce((total, r) => total + (r.products_on_page ?? 0), 0);
        }

        const result = await scanCollection(handle, fetcher, {
            sleepImpl,
            maxAttempts,
            backoffMs,
            startPage,
            initialCumulative,
            priorPageRecords,
            priorSoldOut,
        });

        collectionSummaries.push(result.summary);
        pageOutcomes.push(...result.pageRecords);
        soldOutProducts.push(...result.soldOutProducts);
        await onCollectionComplete?.(checkpoint(null), handle);
    }

    return checkpoint(now());
}
