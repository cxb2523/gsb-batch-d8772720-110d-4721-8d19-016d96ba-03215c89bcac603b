#!/usr/bin/env node
// Command-line runner for a resumable review-collection job.
//
//   node bin/collect-reviews.mjs --place desnudo-coffee-austin --out-dir ./jobs/run1
//   node bin/collect-reviews.mjs --resume ./jobs/run1/job.json
//
// The job file is rewritten after every page (atomic temp-file rename), so killing the
// process at any point loses at most the page in flight. A missing HASDATA_API_KEY exits
// before any network request is made.

import path from 'node:path';
import { runReviewJob, resumeReviewJob, JobStatus, MissingApiKeyError } from '../lib/review-job.mjs';
import { saveJob, loadJob, saveReviews } from '../lib/job-store.mjs';

function parseArgs(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            flags[key] = true;
        } else {
            flags[key] = next;
            i += 1;
        }
    }
    return flags;
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    // On resume the default output location is the directory of the job being resumed, so
    // progress is written back in place rather than forking a second job into ./review-job.
    const outDir = path.resolve(
        flags['out-dir'] ?? (flags.resume ? path.dirname(path.resolve(flags.resume)) : './review-job')
    );
    const jobPath = path.join(outDir, 'job.json');
    const reviewsPath = path.join(outDir, 'reviews.json');

    const onPage = async (job, record) => {
        await saveJob(jobPath, job);
        process.stderr.write(
            `page ${record.page} ${record.status}: ${record.pageCount} reviews ` +
                `(cumulative ${record.cumulativeCount}, hasNextPage=${record.hasNextPage}, attempts=${record.attempts})\n`
        );
    };

    const retry = {
        maxAttempts: flags['max-attempts'] ? Number(flags['max-attempts']) : undefined,
        baseDelayMs: flags['retry-base-ms'] ? Number(flags['retry-base-ms']) : undefined,
    };
    // Drop undefined entries so the library defaults still apply.
    for (const key of Object.keys(retry)) {
        if (retry[key] === undefined) delete retry[key];
    }

    let job;
    try {
        if (flags.resume) {
            const saved = await loadJob(path.resolve(flags.resume));
            job = await resumeReviewJob({
                job: saved,
                endpoint: flags.endpoint,
                maxPages: flags['max-pages'] ? Number(flags['max-pages']) : undefined,
                retry: Object.keys(retry).length ? retry : undefined,
                onPage,
            });
        } else {
            if (!flags.place) {
                process.stderr.write('usage: collect-reviews.mjs --place <yelp-id-or-alias> [--out-dir DIR] [options]\n');
                process.exit(2);
            }
            job = await runReviewJob({
                placeId: flags.place,
                endpoint: flags.endpoint,
                domain: flags.domain,
                sortBy: flags.sort,
                rating: flags.rating,
                languageCode: flags.language,
                num: flags['page-size'] ? Number(flags['page-size']) : undefined,
                maxPages: flags['max-pages'] ? Number(flags['max-pages']) : undefined,
                jobId: flags['job-id'],
                retry: Object.keys(retry).length ? retry : undefined,
                onPage,
            });
        }
    } catch (error) {
        if (error instanceof MissingApiKeyError) {
            process.stderr.write(
                'HASDATA_API_KEY is not set. Create a free key at https://app.hasdata.com and set HASDATA_API_KEY.\n'
            );
            process.exit(1);
        }
        process.stderr.write(`job could not run: ${error.stack ?? error.message}\n`);
        process.exit(1);
    }

    await saveJob(jobPath, job);
    await saveReviews(reviewsPath, job);

    process.stdout.write(
        JSON.stringify(
            {
                status: job.status,
                pages: job.pages.length,
                totalCollected: job.totalCollected,
                jobPath,
                reviewsPath,
                error: job.error,
                warnings: job.warnings,
            },
            null,
            2
        ) + '\n'
    );

    // Partial completion is an operational signal distinct from a hard failure.
    // Set the code and return rather than calling process.exit(): an immediate exit can
    // race libuv handle teardown on Windows (UV_HANDLE_CLOSING assertion) while the fetch
    // sockets are still closing. Letting main() resolve drains them cleanly.
    process.exitCode = job.status === JobStatus.COMPLETED ? 0 : job.status === JobStatus.PARTIAL ? 3 : 4;
}

main();
