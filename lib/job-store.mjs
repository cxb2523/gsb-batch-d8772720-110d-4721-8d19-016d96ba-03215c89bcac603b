// File persistence for review jobs. The engine itself only deals in plain objects; these
// helpers cover the common "save after every page, resume later from disk" workflow.

import fs from 'node:fs/promises';
import path from 'node:path';

export async function saveJob(filePath, job) {
    await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    // Write to a sibling temp file and rename, so a crash mid-write cannot leave a
    // truncated job file that would also destroy the previous good state.
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, filePath);
    return filePath;
}

export async function loadJob(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    const job = JSON.parse(raw);
    if (!job || !Array.isArray(job.pages) || !job.params) {
        throw new Error(`${filePath} does not look like a saved review job`);
    }
    return job;
}

// Reviews on their own, for downstream consumers that do not care about page bookkeeping.
export async function saveReviews(filePath, job) {
    await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(job.reviews, null, 2)}\n`, 'utf8');
    return filePath;
}
