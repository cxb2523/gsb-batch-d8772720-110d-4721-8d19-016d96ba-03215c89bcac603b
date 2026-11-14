import type { TaskContext } from '../base';

/**
 * Resumable paged collection helper.
 *
 * Wraps a site's per-page fetchItems loop so that:
 * - every completed page is recorded (page number, item count, downloaded/failed) and logged;
 * - a page fetch failure stops paging, persists the resume position (page + cursor)
 *   into the task's customConfigJson, and keeps all previously downloaded items;
 * - the next run resumes from the failed page instead of starting over;
 * - hitting the page limit is reported as 'limit_reached', not a failure.
 */

export interface PageResumeState {
	nextPage: number;
	cursor: string | null;
}

export interface PageRecord {
	page: number;
	items: number;
	downloaded: number;
	failed: number;
}

export type PagedStatus = 'completed' | 'page_failed' | 'limit_reached';

export interface PagedRunResult {
	status: PagedStatus;
	pages: PageRecord[];
	downloaded: number;
	failed: number;
	failedPage?: number;
	error?: string;
}

export interface FetchPageResult<T> {
	items: T[];
	hasMore: boolean;
	cursor?: string | null;
}

export interface PagedCollectionOptions<T> {
	ctx: TaskContext;
	label: string;
	maxPages: number;
	fetchPage: (page: number, cursor: string | null) => Promise<FetchPageResult<T>>;
	processPage: (items: T[]) => Promise<void>;
	counters: () => { downloaded: number; failed: number };
}

const RESUME_KEY = 'paginationResume';

export function loadPageResume(task: { customConfigJson: Record<string, unknown> }): PageResumeState | null {
	const raw = (task.customConfigJson as Record<string, unknown>)?.[RESUME_KEY] as Partial<PageResumeState> | null | undefined;
	if (!raw || typeof raw.nextPage !== 'number' || raw.nextPage < 1) return null;
	return { nextPage: Math.floor(raw.nextPage), cursor: (raw.cursor as string | null) ?? null };
}

export async function runPagedCollection<T>(opts: PagedCollectionOptions<T>): Promise<PagedRunResult> {
	const { ctx, label, maxPages, fetchPage, processPage, counters } = opts;
	const pages: PageRecord[] = [];

	const resume = loadPageResume(ctx.task);
	let pageNum = resume?.nextPage ?? 1;
	let cursor: string | null = resume?.cursor ?? null;
	if (resume) {
		ctx.addLog('info', `[${label}] Resuming paged fetch from page ${pageNum}${cursor ? ' (saved cursor)' : ''}`);
	}

	const saveResume = (state: PageResumeState | null): void => {
		ctx.updateCustomConfig({ [RESUME_KEY]: state });
	};

	let requests = 0;
	while (requests < maxPages) {
		let fetched: FetchPageResult<T>;
		try {
			fetched = await fetchPage(pageNum, cursor);
		} catch (err) {
			const message = (err as Error).message;
			ctx.addLog('error', `[${label}] Page ${pageNum} fetch failed: ${message}. Stopping pagination; keeping ${pages.length} completed page(s), will resume from page ${pageNum} next run.`);
			saveResume({ nextPage: pageNum, cursor });
			const c = counters();
			return { status: 'page_failed', pages, downloaded: c.downloaded, failed: c.failed, failedPage: pageNum, error: message };
		}
		requests++;

		const before = { ...counters() };
		await processPage(fetched.items);
		const after = { ...counters() };

		const record: PageRecord = {
			page: pageNum,
			items: fetched.items.length,
			downloaded: after.downloaded - before.downloaded,
			failed: after.failed - before.failed
		};
		pages.push(record);
		ctx.addLog('info', `[${label}] Page ${pageNum} done: ${record.items} items, ${record.downloaded} downloaded, ${record.failed} failed`);

		if (fetched.cursor !== undefined && fetched.cursor !== null) cursor = fetched.cursor;

		if (!fetched.hasMore) {
			saveResume(null);
			const c = counters();
			return { status: 'completed', pages, downloaded: c.downloaded, failed: c.failed };
		}
		pageNum++;
	}

	ctx.addLog('info', `[${label}] Page limit (${maxPages}) reached; not a failure, will continue from page ${pageNum} next run`);
	saveResume({ nextPage: pageNum, cursor });
	const c = counters();
	return { status: 'limit_reached', pages, downloaded: c.downloaded, failed: c.failed };
}
