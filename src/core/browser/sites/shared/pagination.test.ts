/**
 * Standalone test for the resumable paged collection helper.
 *
 * Simulates, with fake fetchItems / download functions:
 *   run 1: page 1 succeeds, page 2 throws  -> status 'page_failed', resume saved at page 2
 *   run 2 (after a simulated restart): resumes at page 2, completes -> resume cleared
 *   run 3: page cap hit                  -> status 'limit_reached' (not a failure)
 *
 * Run with: npm test   (builds, then executes the compiled version of this file)
 */
import assert from 'node:assert';
import { runPagedCollection, loadPageResume, type PagedRunResult } from './pagination';
import type { TaskContext } from '../base';
import type { Task } from '../../../../types';

interface LogEntry { level: string; message: string; }

/** A fake persisted task row; `configJson` stands in for the custom_config_json DB column. */
interface FakeDb { configJson: string; }

function makeTask(db: FakeDb): Task {
	return {
		id: 'task-1',
		name: 'test-task',
		userId: 'u1',
		site: 'douyin',
		paused: false,
		interval: 1800,
		cookies: '',
		customConfigJson: JSON.parse(db.configJson) as Record<string, unknown>,
		next_run: null,
		last_state: 0,
		nextRun: null
	};
}

function makeCtx(task: Task, db: FakeDb, logs: LogEntry[]): TaskContext {
	const ctx = {
		taskId: task.id,
		task,
		addLog: (level: string, message: string) => { logs.push({ level, message }); },
		// Mimics runner.ts updateCustomConfig: merge patch, persist to the "DB" (JSON round-trip
		// proves the resume position survives a restart), keep the in-memory task in sync.
		updateCustomConfig: (patch: Record<string, unknown>) => {
			const merged: Record<string, unknown> = { ...(JSON.parse(db.configJson) as Record<string, unknown>) };
			for (const [key, value] of Object.entries(patch)) {
				if (value === null || value === undefined) delete merged[key];
				else merged[key] = value;
			}
			db.configJson = JSON.stringify(merged);
			task.customConfigJson = merged;
		}
	};
	return ctx as unknown as TaskContext;
}

/** Fake site: page 1 -> 3 items, page 2 -> throws while `failPage2`, then 2 items, page 3 -> 1 item, no more. */
function makeFakeSite() {
	const calls: number[] = [];
	const state = { failPage2: true };
	const pages: Record<number, { items: string[]; hasMore: boolean }> = {
		1: { items: ['a', 'b', 'c'], hasMore: true },
		2: { items: ['d', 'e'], hasMore: true },
		3: { items: ['f'], hasMore: false }
	};
	const fetchPage = async (pageNum: number) => {
		calls.push(pageNum);
		if (pageNum === 2 && state.failPage2) throw new Error('simulated page 2 fetch error');
		const p = pages[pageNum];
		if (!p) return { items: [] as string[], hasMore: false };
		return { items: p.items, hasMore: p.hasMore };
	};
	return { calls, state, fetchPage };
}

/** Fake download pool: items already in `successfulDownloads` are skipped (hasSuccessfulDownload logic). */
function makeDownloader(successfulDownloads: Set<string>) {
	const counters = { downloaded: 0, failed: 0 };
	const processPage = async (items: string[]) => {
		for (const id of items) {
			if (successfulDownloads.has(id)) continue; // already downloaded before: skip (and would unfavorite)
			counters.downloaded++;
			successfulDownloads.add(id);
		}
	};
	return { counters, processPage };
}

async function main(): Promise<void> {
	// ---------- Run 1: page 1 ok, page 2 throws ----------
	const db: FakeDb = { configJson: '{}' };
	const logs: LogEntry[] = [];
	const site = makeFakeSite();
	const dl = makeDownloader(new Set<string>());

	const result1: PagedRunResult = await runPagedCollection<string>({
		ctx: makeCtx(makeTask(db), db, logs),
		label: 'Fake',
		maxPages: 20,
		fetchPage: site.fetchPage,
		processPage: dl.processPage,
		counters: () => dl.counters
	});

	assert.strictEqual(result1.status, 'page_failed', 'run 1 should end with page_failed');
	assert.strictEqual(result1.failedPage, 2, 'run 1 should fail on page 2');
	assert.strictEqual(result1.error, 'simulated page 2 fetch error');
	assert.deepStrictEqual(result1.pages, [{ page: 1, items: 3, downloaded: 3, failed: 0 }], 'page 1 record');
	assert.strictEqual(result1.downloaded, 3, 'page 1 downloads are kept');
	assert.deepStrictEqual(site.calls, [1, 2], 'run 1 fetched pages 1 then 2');
	assert.deepStrictEqual(loadPageResume({ customConfigJson: JSON.parse(db.configJson) }), { nextPage: 2, cursor: null }, 'resume saved at page 2');
	assert.ok(logs.some(l => l.level === 'info' && l.message.includes('Page 1 done: 3 items, 3 downloaded, 0 failed')), 'page 1 log written');
	assert.ok(logs.some(l => l.level === 'error' && l.message.includes('Page 2 fetch failed: simulated page 2 fetch error')), 'page 2 failure logged with error');

	// ---------- Run 2: simulated restart, resumes from page 2 ----------
	const logs2: LogEntry[] = [];
	site.state.failPage2 = false;
	site.calls.length = 0;
	// brand-new task object re-read from the "DB" — proves the resume position survives a restart
	const result2: PagedRunResult = await runPagedCollection<string>({
		ctx: makeCtx(makeTask(db), db, logs2),
		label: 'Fake',
		maxPages: 20,
		fetchPage: site.fetchPage,
		processPage: dl.processPage,
		counters: () => dl.counters
	});

	assert.strictEqual(result2.status, 'completed', 'run 2 should complete');
	assert.deepStrictEqual(site.calls, [2, 3], 'run 2 resumed at page 2, not page 1');
	assert.deepStrictEqual(result2.pages, [
		{ page: 2, items: 2, downloaded: 2, failed: 0 },
		{ page: 3, items: 1, downloaded: 1, failed: 0 }
	], 'run 2 page records');
	assert.strictEqual(result2.downloaded, 6, 'all 6 items downloaded across both runs');
	assert.strictEqual(loadPageResume({ customConfigJson: JSON.parse(db.configJson) }), null, 'resume cleared after completion');
	assert.ok(logs2.some(l => l.message.includes('Resuming paged fetch from page 2')), 'resume logged');

	// ---------- Run 3: page cap -> limit_reached, not a failure ----------
	const db3: FakeDb = { configJson: '{}' };
	const logs3: LogEntry[] = [];
	const dl3 = makeDownloader(new Set<string>());
	let fetchCount = 0;
	const result3: PagedRunResult = await runPagedCollection<string>({
		ctx: makeCtx(makeTask(db3), db3, logs3),
		label: 'Fake',
		maxPages: 2,
		fetchPage: async (pageNum) => { fetchCount++; return { items: [`x${pageNum}`], hasMore: true }; },
		processPage: dl3.processPage,
		counters: () => dl3.counters
	});

	assert.strictEqual(result3.status, 'limit_reached', 'run 3 should hit the page cap');
	assert.strictEqual(fetchCount, 2, 'exactly maxPages fetches');
	assert.deepStrictEqual(loadPageResume({ customConfigJson: JSON.parse(db3.configJson) }), { nextPage: 3, cursor: null }, 'resume saved past the cap');
	assert.ok(logs3.some(l => l.message.includes('Page limit (2) reached')), 'limit logged as non-failure');

	console.log('pagination.test: all assertions passed');
}

main().catch(err => {
	console.error('pagination.test FAILED:', err);
	process.exit(1);
});
