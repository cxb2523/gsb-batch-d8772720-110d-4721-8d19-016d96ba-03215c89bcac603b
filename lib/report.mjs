// Human-readable rendering of a catalogue scan record. The JSON record is the source of truth for
// resuming and diffing; these functions turn it into something a reader can audit.

import { OUTCOME_LABELS, PAGE_LIMIT } from './catalog-scan.mjs';

function formatNumber(value) {
    return value === null || value === undefined ? 'n/a' : String(value);
}

function formatPrice(value) {
    return value === null || value === undefined ? 'n/a' : value.toFixed(2);
}

export function renderPageOutcomesTable(record) {
    const lines = [
        '| collection (handle) | page | outcome | products on page | cumulative products | attempts | price min | price max | discounted variants |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const row of record.page_outcomes) {
        lines.push(
            `| ${row.collection} | ${row.page} | ${OUTCOME_LABELS[row.outcome] ?? row.outcome} | ${row.products_on_page} | ${row.cumulative_products} | ${row.attempts ?? ''} | ${formatPrice(row.price_min)} | ${formatPrice(row.price_max)} | ${formatNumber(row.discounted_variants)} |`
        );
    }
    return lines.join('\n');
}

export function renderCollectionSummary(record) {
    const lines = [
        '| collection (handle) | status | pages | products | price min | price max | discounted variants | failure reason | needs resume |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const summary of record.collections) {
        lines.push(
            `| ${summary.collection} | ${summary.status} | ${summary.pages} | ${summary.product_count} | ${formatPrice(summary.price_min)} | ${formatPrice(summary.price_max)} | ${summary.discounted_variants} | ${summary.failure_reason ?? ''} | ${summary.needs_resume ? `yes (page ${summary.resume_from_page})` : 'no'} |`
        );
    }
    return lines.join('\n');
}

export function renderSoldOut(record) {
    if (record.sold_out_products.length === 0) return '_No products with every variant unavailable._';
    const lines = [
        '| collection | product handle | title | vendor | product_type |',
        '| --- | --- | --- | --- | --- |',
    ];
    for (const product of record.sold_out_products) {
        lines.push(
            `| ${product.collection} | ${product.handle} | ${product.title ?? ''} | ${product.vendor ?? ''} | ${product.product_type ?? ''} |`
        );
    }
    return lines.join('\n');
}

export function renderResumeList(record) {
    if (record.collections_needing_resume.length === 0) {
        return '_No collections need a resume run; every collection reached its short page or an empty page._';
    }
    const lines = [];
    for (const item of record.collections_needing_resume) {
        lines.push(`- \`${item.collection}\` — ${item.reason}; ${item.resume_hint}`);
    }
    return lines.join('\n');
}

export function renderMarkdownReport(record) {
    const totals = record.totals;
    const sections = [
        `# Catalogue scan: ${record.url}`,
        '',
        `- started: ${record.started_at ?? ''}`,
        `- finished: ${record.finished_at ?? ''}`,
        `- page size: limit=${record.limit ?? PAGE_LIMIT}, page starting at 1, collection handle passed as \`collection\``,
        `- collections: ${totals.collections} (${totals.collections_completed} complete, ${totals.collections_failed} failed)`,
        `- pages: ${totals.pages} — ${totals.successful_pages} success, ${totals.empty_pages} empty, ${totals.non_shopify_pages} non-Shopify, ${totals.rate_limited_pages} rate-limited`,
        `- products collected: ${totals.products}; sold-out products (all variants unavailable): ${totals.sold_out_products}`,
        '',
        '## Page-by-page outcomes',
        '',
        renderPageOutcomesTable(record),
        '',
        '## Collection summary',
        '',
        renderCollectionSummary(record),
        '',
        '## Sold-out products',
        '',
        renderSoldOut(record),
        '',
        '## Collections that need a resume run',
        '',
        renderResumeList(record),
        '',
    ];
    return sections.join('\n');
}
