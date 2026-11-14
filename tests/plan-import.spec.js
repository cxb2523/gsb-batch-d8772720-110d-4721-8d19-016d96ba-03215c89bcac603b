// Importing a lesson plan from a list (plan.html): the pages of the list are collected one by one,
// each with its outcome, and an interrupted import goes on where it stopped. The lists are made in
// the tests themselves — an address on this site, or a local file — and nothing outside the site is
// ever asked for.
const { test } = require('@playwright/test');
const { expect } = require('./helpers');

// Opens plan.html, records page errors and console errors, and fails if a request leaves the site.
async function openPlanPage(page) {
	const problems = [];
	page.on('pageerror', e => problems.push('page error: ' + e.message));
	page.on('console', m => {
		// the network failures and the 404 of this test are on purpose; their own messages say so
		if (m.type() === 'error' && !/willReadFrequently|Failed to load resource/.test(m.text())) problems.push('console: ' + m.text());
	});
	await page.route(url => !/^https?:\/\/localhost[:/]/.test(url.href), route => {
		problems.push('external request: ' + route.request().url());
		return route.abort();
	});
	await page.addInitScript(() => localStorage.setItem('dsv-tour-done', '1'));
	await page.goto('/plan.html');
	await page.waitForSelector('#pp-import');
	return problems;
}

// A list served like a file next to plan.html.
const listUrl = path => 'http://localhost:8765' + path;
async function serveList(page, path, items) {
	await page.unroute(listUrl(path));
	await page.route(listUrl(path), route => route.fulfill({
		contentType: 'application/json',
		body: typeof items === 'string' ? items : JSON.stringify(items)
	}));
}

const rows = page => page.locator('#pp-import-rows .pp-import-row');

test('a list: normal, skipped, duplicate and shortened pages get one row each, and the counts add up', async ({ page }) => {
	const problems = await openPlanPage(page);
	const long = 'N'.repeat(650);
	const list = [
		{ file: 'stack.html', note: 'İlk sayfa.', lang: 'cpp' },
		{ file: 'nope.html', note: 'Yok.' },
		{ file: 'queue.html', note: '' },
		{ file: 'stack.html', note: 'Yine.' },
		{ file: 'recursion.html', note: long, lang: 'java' }
	];
	await serveList(page, '/test-list-normal.json', list);
	await page.fill('#pp-import-url', '/test-list-normal.json');
	await page.click('#pp-import-start');

	await expect(rows(page)).toHaveCount(5);
	await expect(rows(page).nth(0)).toHaveAttribute('data-status', 'normal');
	await expect(rows(page).nth(0).locator('.pp-imp-file')).toHaveText('stack.html');
	await expect(rows(page).nth(0).locator('.pp-imp-status')).toHaveText('Normal');
	await expect(rows(page).nth(1)).toHaveAttribute('data-status', 'skipped');
	await expect(rows(page).nth(1).locator('.pp-imp-file')).toHaveText('nope.html');   // the name is written down
	await expect(rows(page).nth(1).locator('.pp-imp-status')).toHaveText('Atlandı');
	await expect(rows(page).nth(2)).toHaveAttribute('data-status', 'normal');
	await expect(rows(page).nth(3)).toHaveAttribute('data-status', 'duplicate');      // the first stack.html stays
	await expect(rows(page).nth(3).locator('.pp-imp-file')).toHaveText('stack.html');
	await expect(rows(page).nth(3).locator('.pp-imp-status')).toHaveText('Yinelenen');
	await expect(rows(page).nth(4)).toHaveAttribute('data-status', 'truncated');
	await expect(rows(page).nth(4).locator('.pp-imp-status')).toHaveText('Kısaltıldı');

	await expect(page.locator('#pp-import-counts')).toHaveText('Normal 2 · Atlandı 1 · Yinelenen 1 · Kısaltıldı 1');
	await expect(page.locator('#pp-import-summary')).toContainText('5 öğe işlendi');
	await expect(page.locator('#pp-import-status')).toHaveText('İçe aktarma bitti.');

	// the bookkeeping uses this site's pages only; the note was cut to 600 characters
	const job = await page.evaluate(() => window.dsvPlanImport.job());
	expect(job.entries.map(e => e.status)).toEqual(['normal', 'skipped', 'normal', 'duplicate', 'truncated']);
	expect(job.entries.map(e => e.file)).toEqual(['stack.html', 'nope.html', 'queue.html', 'stack.html', 'recursion.html']);
	expect(job.entries[0].lang).toBe('cpp');
	expect(job.entries[4].note.length).toBe(600);

	// the imported plan has the pages that could be taken, each with its own code language
	await expect(page.locator('#pp-import-open')).toBeVisible();
	const href = await page.locator('#pp-import-open').getAttribute('href');
	expect(href).toMatch(/^stack\.html#plan=/);                                  // it opens at the plan's first page
	const plan = JSON.parse(Buffer.from(href.split('#plan=')[1].split('&')[0], 'base64url').toString());
	expect(plan.i.map(x => x[0])).toEqual(['stack.html', 'queue.html', 'recursion.html']);
	expect(plan.i[0][2]).toBe('cpp');
	expect(plan.i[2][2]).toBe('java');
	expect(problems).toEqual([]);
});

test('a network break stops the import; a reload keeps what was done and continues from the break', async ({ page }) => {
	const problems = await openPlanPage(page);
	const list = [
		{ file: 'stack.html', note: '' },
		{ file: 'queue.html', note: '' },
		{ file: 'lengthOfALinkedList.html', note: '' },
		{ file: 'nope.html', note: '' },
		{ file: 'recursion.html', note: '' },
		{ file: 'heap.html', note: '' }
	];
	await serveList(page, '/test-list-resume.json', list);

	// the third page cannot be fetched once; from then on everything is served
	let attempts = 0, failOnce = true;
	const third = listUrl('/lengthOfALinkedList.html');
	await page.route(third, route => {
		attempts++;
		if (failOnce) { failOnce = false; return route.abort('failed'); }
		return route.continue();
	});
	await page.fill('#pp-import-url', '/test-list-resume.json');
	await page.click('#pp-import-start');

	await expect(page.locator('#pp-import-status')).toContainText('lengthOfALinkedList.html');
	await expect(rows(page)).toHaveCount(2);                    // the two pages before the break
	await expect(page.locator('#pp-import-summary')).toBeHidden();
	let job = await page.evaluate(() => window.dsvPlanImport.job());
	expect(job.next).toBe(2);
	expect(job.complete).toBe(false);
	expect(attempts).toBe(1);

	// a reload keeps the two rows and goes on by itself from the page that broke
	const asked = [];
	page.on('request', r => {
		const p = new URL(r.url()).pathname;
		if (/^\/[\w.]+\.html$/.test(p) && p !== '/plan.html') asked.push(p); // the pages the import fetches
	});
	await page.unroute(third);
	await page.reload();
	await page.waitForSelector('#pp-import');
	await expect(rows(page)).toHaveCount(6);
	await expect(page.locator('#pp-import-summary')).toBeVisible();
	await expect(page.locator('#pp-import-status')).toHaveText('İçe aktarma bitti.');
	await expect(page.locator('#pp-import-counts')).toHaveText('Normal 5 · Atlandı 1 · Yinelenen 0 · Kısaltıldı 0');
	// only the pages not done before are fetched: stack and queue were not fetched again
	expect(asked).toEqual(['/lengthOfALinkedList.html', '/recursion.html', '/heap.html']);
	await expect(rows(page).first()).toHaveAttribute('data-status', 'normal');
	await expect(rows(page).nth(3)).toHaveAttribute('data-status', 'skipped');
	const done = await page.evaluate(() => window.dsvPlanImport.job());
	expect(done.next).toBe(6);
	expect(done.complete).toBe(true);
	expect(problems).toEqual([]);
});

test('a reload in the middle of a running import goes on by itself, from the page it had reached', async ({ page }) => {
	const problems = await openPlanPage(page);
	const list = [
		{ file: 'stack.html', note: '' },
		{ file: 'queue.html', note: '' },
		{ file: 'recursion.html', note: '' },
		{ file: 'heap.html', note: '' }
	];
	await serveList(page, '/test-list-refresh.json', list);
	// slow pages, so the reload happens after the first one and before the last one
	await page.route(/localhost:8765\/(stack|queue|recursion|heap)\.html$/, async route => {
		await new Promise(r => setTimeout(r, 120));
		return route.continue();
	});
	await page.fill('#pp-import-url', '/test-list-refresh.json');
	await page.click('#pp-import-start');
	await expect(rows(page)).toHaveCount(1);
	// the reload lands somewhere in the middle: after the first page, before the last one
	const before = await page.evaluate(() => window.dsvPlanImport.job().next);
	expect(before).toBeGreaterThanOrEqual(1);
	expect(before).toBeLessThan(4);

	await page.reload();
	await page.waitForSelector('#pp-import');
	await expect(page.locator('#pp-import-summary')).toBeVisible();
	await expect(rows(page)).toHaveCount(4);
	await expect(page.locator('#pp-import-counts')).toHaveText('Normal 4 · Atlandı 0 · Yinelenen 0 · Kısaltıldı 0');
	await expect(page.locator('#pp-import-status')).toHaveText('İçe aktarma bitti.');
	await expect(rows(page).first()).toHaveAttribute('data-status', 'normal');
	const job = await page.evaluate(() => window.dsvPlanImport.job());
	expect(job.next).toBe(4);
	expect(job.entries.every(e => e.fetched)).toBe(true);
	expect(problems).toEqual([]);
});

test('pause keeps the pages done, and the same list imported again adds no rows twice', async ({ page }) => {
	const problems = await openPlanPage(page);
	const list = [{ file: 'stack.html', note: 'a' }, { file: 'queue.html', note: 'b' }, { file: 'recursion.html', note: 'c' }];
	await serveList(page, '/test-list-twice.json', list);
	await page.route(/localhost:8765\/(stack|queue|recursion)\.html$/, async route => {
		await new Promise(r => setTimeout(r, 150));
		return route.continue();
	});

	await page.fill('#pp-import-url', '/test-list-twice.json');
	await page.click('#pp-import-start');
	await expect(rows(page)).toHaveCount(1);
	await page.click('#pp-import-pause');
	await expect(page.locator('#pp-import-pause')).toBeHidden();
	await expect(page.locator('#pp-import-resume')).toBeVisible();
	const paused = await page.evaluate(() => window.dsvPlanImport.job());
	expect(paused.complete).toBe(false);
	expect(paused.next).toBeGreaterThanOrEqual(1);
	expect(paused.next).toBeLessThan(3);
	await expect(rows(page)).toHaveCount(paused.next);

	// a reload of a paused import stays paused and keeps the rows; continue finishes it
	await page.reload();
	await page.waitForSelector('#pp-import');
	await expect(page.locator('#pp-import-resume')).toBeVisible();
	await expect(rows(page)).toHaveCount(paused.next);
	await page.click('#pp-import-resume');
	await expect(page.locator('#pp-import-summary')).toBeVisible();
	await expect(rows(page)).toHaveCount(3);

	// the same list again: the same rows, not twice as many
	await page.fill('#pp-import-url', '/test-list-twice.json');
	await page.click('#pp-import-start');
	await expect(page.locator('#pp-import-status')).toHaveText('İçe aktarma bitti.');
	await expect(rows(page)).toHaveCount(3);
	await expect(page.locator('#pp-import-counts')).toHaveText('Normal 3 · Atlandı 0 · Yinelenen 0 · Kısaltıldı 0');
	expect(await page.evaluate(() => window.dsvPlanImport.job().next)).toBe(3);

	// the same list again when it had broken before: no "continue" by hand, no row twice
	await page.unroute(listUrl('/test-list-break.json'));
	await serveList(page, '/test-list-break.json', list);
	let broke = true;
	await page.route(listUrl('/queue.html'), route => {
		if (broke) { broke = false; return route.abort('failed'); }
		return route.continue();
	});
	await page.fill('#pp-import-url', '/test-list-break.json');
	await page.click('#pp-import-start');
	await expect(page.locator('#pp-import-status')).toContainText('queue.html');
	await expect(rows(page)).toHaveCount(1);
	await page.fill('#pp-import-url', '/test-list-break.json');   // the teacher tries the same list again
	await page.click('#pp-import-start');
	await expect(page.locator('#pp-import-status')).toHaveText('İçe aktarma bitti.');
	await expect(rows(page)).toHaveCount(3);
	await expect(page.locator('#pp-import-counts')).toHaveText('Normal 3 · Atlandı 0 · Yinelenen 0 · Kısaltıldı 0');
	expect(problems).toEqual([]);
});

test('a local list file works too, and a broken list gives a readable error without changing the plan', async ({ page }) => {
	const problems = await openPlanPage(page);
	const list = [{ file: 'stack.html', note: 'Dosyadan.' }, { file: 'nope.html' }];
	await page.setInputFiles('#pp-import-file', { name: 'hafta.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(list)) });
	await page.click('#pp-import-start');
	await expect(rows(page)).toHaveCount(2);
	await expect(page.locator('#pp-import-counts')).toHaveText('Normal 1 · Atlandı 1 · Yinelenen 0 · Kısaltıldı 0');
	const before = await page.evaluate(() => window.dsvPlanImport.job());

	// not JSON, not an array, an empty array: a readable error each time, and the rows stay as they were
	for (const [body, message] of [['{oops', 'geçerli bir JSON değil'], ['{"a":1}', 'bir JSON dizisi olmalı'], ['[]', 'işlenecek öğe yok']]) {
		await serveList(page, '/test-list-bad.json', body);
		await page.fill('#pp-import-url', '/test-list-bad.json');
		await page.click('#pp-import-start');
		await expect(page.locator('#pp-import-error')).toBeVisible();
		await expect(page.locator('#pp-import-error')).toContainText(message);
		await expect(rows(page)).toHaveCount(2);
		expect(await page.evaluate(() => window.dsvPlanImport.job())).toEqual(before);
	}

	// a list that cannot be downloaded: an error, and still nothing changed
	await page.unroute(listUrl('/missing.json'));
	await page.route(listUrl('/missing.json'), route => route.fulfill({ status: 404, body: 'nope' }));
	await page.fill('#pp-import-url', '/missing.json');
	await page.click('#pp-import-start');
	await expect(page.locator('#pp-import-error')).toContainText('Liste indirilemedi');
	await expect(rows(page)).toHaveCount(2);

	// a list on another site is refused before anything is requested
	await page.fill('#pp-import-url', 'https://evil.example/list.json');
	await page.click('#pp-import-start');
	await expect(page.locator('#pp-import-error')).toContainText('Yalnızca bu sitedeki');
	expect(await page.evaluate(() => window.dsvPlanImport.job())).toEqual(before);
	expect(problems).toEqual([]);
});

test('the imported plan opens with each page in its own code language', async ({ page }) => {
	const problems = await openPlanPage(page);
	const list = [{ file: 'stack.html', note: 'C++ ile.', lang: 'cpp' }, { file: 'queue.html', note: '', lang: 'java' }];
	await serveList(page, '/test-list-open.json', list);
	await page.fill('#pp-import-url', '/test-list-open.json');
	await page.click('#pp-import-start');
	await expect(page.locator('#pp-import-summary')).toBeVisible();

	await page.click('#pp-import-open');
	await page.waitForFunction(() => window.dsvReady === true);
	await expect(page).toHaveURL(/\/stack\.html#plan=/);
	await expect(page.locator('.code-label').first()).toHaveText('Blok 1 · C++');
	await expect(page.locator('.plan-note')).toContainText('C++ ile.');
	await expect(page.locator('.plan-bar .plan-count')).toHaveText('1 / 2');

	await page.click('.plan-bar .plan-next');
	await page.waitForFunction(() => window.dsvReady === true);
	await expect(page).toHaveURL(/\/queue\.html#plan=/);
	await expect(page.locator('.code-label').first()).toHaveText('Blok 1 · Java');   // this page's own language
	expect(problems).toEqual([]);
});
