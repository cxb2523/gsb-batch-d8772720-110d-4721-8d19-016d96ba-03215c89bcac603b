// Reusable snapshot pipeline for public Facebook pages.
//
// One snapshot walks the profile feed with `pagination.nextPageToken` until the feed ends, the
// page budget runs out, or a page fails. Everything already fetched is kept: a failed page
// never throws away the posts before it, and the result always says what happened to every page
// and how many billable calls were spent, so a run can be audited or resumed.
//
// The module takes its tool client as a dependency (`client.call(...)`), which keeps the whole
// pipeline testable against local fixtures with no API key and no billed traffic.

import { ToolCallError, TOOL_NAME } from './mcp-client.mjs';

export const DEFAULT_MAX_PAGES = 4;
export const DEFAULT_TOP_POSTS = 5;

/** Page outcomes, one per request. `success` and `end` yielded posts; the others did not. */
export const PAGE_STATUS = {
    SUBMITTED: 'success', // data returned, the feed has more
    END: 'end', // data returned, no nextPageToken: feed exhausted
    FAILED: 'failed', // no data: retries exhausted on a throttle/transport failure
    UNAVAILABLE: 'unavailable', // no data: payload carried `error` instead of `profile`/`posts`
};

/** Why the walk stopped. */
export const STOP_REASON = {
    FEED_END: 'feed_end',
    MAX_PAGES: 'max_pages',
    PAGE_UNAVAILABLE: 'page_unavailable',
    CALL_FAILED: 'call_failed',
    REPEATED_TOKEN: 'repeated_token',
};

const PROFILE_FIELDS = [
    'id',
    'pageId',
    'name',
    'username',
    'url',
    'category',
    'biography',
    'likesCount',
    'talkingAboutCount',
    'checkInsCount',
    'followersCount',
    'followingCount',
    'verified',
    'website',
    'websiteUrl',
    'phone',
    'owner',
    'profilePicUrl',
    'coverPhotoUrl',
];

export function pickProfile(profile) {
    const out = {};
    for (const field of PROFILE_FIELDS) {
        if (profile[field] !== undefined) out[field] = profile[field];
    }
    return out;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

/** The payload of a page that does not exist, was deleted or is not public. */
function payloadError(payload) {
    if (!isObject(payload) || payload.error === undefined) return null;
    const raw = payload.error;
    if (typeof raw === 'string') return { message: raw };
    if (isObject(raw)) {
        return {
            code: raw.code ?? raw.type ?? 'page_unavailable',
            message: raw.message ?? raw.description ?? JSON.stringify(raw),
        };
    }
    return { message: JSON.stringify(raw) };
}

function asCount(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return 0;
}

function engagementOf(post) {
    const reactions = asCount(post?.reactionsCount);
    const comments = asCount(post?.commentsCount);
    const shares = asCount(post?.sharesCount);
    return { reactions, comments, shares, total: reactions + comments + shares };
}

function timestampMs(post) {
    if (!post?.timestamp) return null;
    const ms = Date.parse(post.timestamp);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Posting cadence over the posts actually returned.
 *
 * A single post has no interval to measure, so the cadence is reported as null rather than
 * invented from `postsPerPage`. `postsPerDay` uses the span between the oldest and newest post;
 * the median gap is robust against a burst of posts and is reported alongside it.
 */
export function computeCadence(posts) {
    const times = posts
        .map(timestampMs)
        .filter((ms) => ms !== null)
        .sort((a, b) => a - b);
    if (!times.length) {
        return { postsWithTimestamp: 0, spanDays: null, postsPerDay: null, medianGapHours: null, newest: null, oldest: null };
    }
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const sortedGaps = gaps.slice().sort((a, b) => a - b);
    const medianGapMs = sortedGaps.length
        ? sortedGaps.length % 2
            ? sortedGaps[(sortedGaps.length - 1) / 2]
            : (sortedGaps[sortedGaps.length / 2 - 1] + sortedGaps[sortedGaps.length / 2]) / 2
        : null;
    const spanMs = times.length > 1 ? times[times.length - 1] - times[0] : 0;
    const spanDays = spanMs / 86_400_000;
    return {
        postsWithTimestamp: times.length,
        spanDays: Number(spanDays.toFixed(2)),
        // One post is one observed post: rate over a sub-day span would overstate it, so count
        // intervals rather than posts.
        postsPerDay: times.length > 1 && spanDays > 0 ? Number(((times.length - 1) / spanDays).toFixed(2)) : null,
        medianGapHours: medianGapMs === null ? null : Number((medianGapMs / 3_600_000).toFixed(2)),
        newest: new Date(times[times.length - 1]).toISOString(),
        oldest: new Date(times[0]).toISOString(),
    };
}

/** Rank posts by reactions + comments + shares. `reactionsCount` is the tie-breaker. */
export function rankPosts(posts, limit = DEFAULT_TOP_POSTS) {
    return posts
        .map((post, index) => ({ post, index, engagement: engagementOf(post) }))
        .sort((a, b) => b.engagement.total - a.engagement.total || b.engagement.reactions - a.engagement.reactions || a.index - b.index)
        .slice(0, Math.max(0, limit))
        .map(({ post, engagement }, rank) => ({
            rank: rank + 1,
            id: post?.id ?? null,
            url: post?.url ?? null,
            timestamp: post?.timestamp ?? null,
            text: post?.text ?? null,
            reactionsCount: engagement.reactions,
            commentsCount: engagement.comments,
            sharesCount: engagement.shares,
            engagementTotal: engagement.total,
        }));
}

export function computeStats(posts, { topPosts = DEFAULT_TOP_POSTS } = {}) {
    const counts = posts.map(engagementOf);
    const totals = counts.reduce(
        (acc, value) => ({
            reactions: acc.reactions + value.reactions,
            comments: acc.comments + value.comments,
            shares: acc.shares + value.shares,
            engagement: acc.engagement + value.total,
        }),
        { reactions: 0, comments: 0, shares: 0, engagement: 0 },
    );
    const n = posts.length;
    const average = n
        ? Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number((value / n).toFixed(2))]))
        : { reactions: 0, comments: 0, shares: 0, engagement: 0 };
    return {
        postsCollected: n,
        byPage: null, // filled by the runner, which knows the page boundaries
        cadence: computeCadence(posts),
        totals,
        averagePerPost: average,
        topPosts: rankPosts(posts, topPosts),
    };
}

function normalizeCalls() {
    return { billable: 0, attempts: 0, retries: 0 };
}

function recordCall(calls, result) {
    const attempts = Math.max(1, Number(result?.attempts) || 1);
    const billed = result?.billed !== false; // a completed tool call is billed by default
    calls.attempts += attempts;
    calls.retries += attempts - 1;
    if (billed) calls.billable += 1;
}

function failureReason(err) {
    const wrapped = err instanceof ToolCallError
        ? err
        : new ToolCallError(err?.message ?? String(err), { code: 'call_failed', retryable: false, attempts: 1 });
    return {
        code: wrapped.code,
        message: wrapped.message,
        retryable: wrapped.retryable,
        attempts: wrapped.attempts,
        billed: wrapped.billed,
        status: wrapped.status,
    };
}

/**
 * Take one snapshot.
 *
 * @param {object} options
 * @param {string} options.handle                Page handle, @username or numeric id.
 * @param {string} [options.language]            Localization code, sent on every page.
 * @param {object} options.client                Object with an async `call(args)` returning
 *                                               `{ payload, attempts?, billed? }`.
 * @param {number} [options.maxPages=4]          Total pages to request, first page included.
 * @param {number} [options.topPosts=5]          How many top posts to rank.
 * @param {string} [options.startToken]          Resume an interrupted walk from this token.
 * @param {object} [options.prior]               Earlier partial result to merge into.
 * @param {number|Date} [options.now]            Clock injection for deterministic output.
 * @returns {Promise<object>} The snapshot. It is returned on failure too; failures live in
 *                            `available`, `pages[]` and `stop.reason`, not in a thrown error.
 */
export async function snapshotPage({
    handle,
    language,
    client,
    maxPages = DEFAULT_MAX_PAGES,
    topPosts = DEFAULT_TOP_POSTS,
    startToken,
    prior,
    now,
    toolName = TOOL_NAME,
} = {}) {
    if (!nonEmptyString(handle)) throw new TypeError('handle must be a non-empty string');
    if (!client || typeof client.call !== 'function') throw new TypeError('client with call(args) is required');
    const pageBudget = Math.max(1, Math.trunc(Number(maxPages) || DEFAULT_MAX_PAGES));
    if (startToken !== undefined && !nonEmptyString(startToken)) throw new TypeError('startToken must be a non-empty string when given');
    if (prior !== undefined && prior !== null && !startToken) {
        // Merging without a token would replay the opening page and append its posts twice.
        throw new TypeError('prior is only merged with a startToken; pass the resume token too');
    }

    const startedAt = toISO(now ?? Date.now());
    const calls = normalizeCalls();
    const pages = [];
    const posts = [];
    const postsByPage = [];
    let profile = isObject(prior?.profile) ? prior.profile : null;
    let photos = Array.isArray(prior?.photos) ? prior.photos : [];
    if (prior?.posts?.length) {
        posts.push(...prior.posts);
        postsByPage.push({ page: 'prior', status: 'merged', posts: prior.posts.length });
    }
    if (Array.isArray(prior?.pages)) pages.push(...prior.pages);

    const baseArgs = { handle };
    if (language !== undefined) baseArgs.language = language;

    let token = startToken;
    let stop = null;
    let available = profile !== null ? true : null;
    const seenTokens = new Set(token ? [token] : []);

    // On a resumed run the page numbers continue after the pages already recorded, while the
    // request budget counts only the calls this run is allowed to make.
    const priorPageNumbers = pages.map((page) => (Number.isInteger(page.page) ? page.page : 0));
    const startPageNo = Math.max(0, ...priorPageNumbers, Number(prior?.resume?.stoppedAtPage) || 0) + 1;
    let requestNo = 0;
    let pageNo = startPageNo - 1;

    while (!stop) {
        if (requestNo >= pageBudget) {
            stop = { reason: STOP_REASON.MAX_PAGES, message: `stopped after ${pageBudget} page(s)` };
            break;
        }
        requestNo += 1;
        pageNo = startPageNo + requestNo - 1;
        const isFirst = requestNo === 1 && !startToken;
        const args = { ...baseArgs };
        if (token) args.nextPageToken = token;
        const call = { page: pageNo, kind: isFirst ? 'profile+feed' : 'token', args };

        let result;
        try {
            result = await client.call(args);
        } catch (err) {
            const reason = failureReason(err);
            // A completed-but-errored call is billed even though it yielded nothing.
            calls.attempts += reason.attempts;
            calls.retries += Math.max(0, reason.attempts - 1);
            if (reason.billed) calls.billable += 1;
            // A retry exhaustion leaves the previous posts untouched and ends the walk; there is
            // no token to advance with, so requesting more pages would only burn calls.
            pages.push({ page: pageNo, kind: call.kind, status: PAGE_STATUS.FAILED, posts: 0, reason, nextPageToken: null });
            stop = { reason: STOP_REASON.CALL_FAILED, message: `page ${pageNo} failed: ${reason.message}`, page: pageNo, error: reason };
            break;
        }

        recordCall(calls, result);
        const payload = isObject(result?.payload) ? result.payload : {};
        const pageError = payloadError(payload);

        if (pageError) {
            // The API answers 200 with `error` instead of the page. This is a completed,
            // billable call, and no further token may be requested.
            pages.push({
                page: pageNo,
                kind: call.kind,
                status: PAGE_STATUS.UNAVAILABLE,
                posts: 0,
                reason: { code: pageError.code ?? 'page_unavailable', message: pageError.message, kind: 'payload_error' },
                nextPageToken: null,
                pagination: payload.pagination ?? null,
            });
            stop = { reason: STOP_REASON.PAGE_UNAVAILABLE, message: `page ${pageNo} is not available: ${pageError.message}`, page: pageNo };
            if (available === null) available = false;
            break;
        }

        const pagePosts = Array.isArray(payload.posts) ? payload.posts : [];
        if (isFirst && !isObject(payload.profile)) {
            // A response without profile and without an error means the contract changed.
            pages.push({
                page: pageNo,
                kind: call.kind,
                status: PAGE_STATUS.FAILED,
                posts: 0,
                reason: { code: 'missing_profile', message: 'the opening response carried neither profile nor error', kind: 'invalid_payload' },
                nextPageToken: null,
            });
            stop = { reason: STOP_REASON.PAGE_UNAVAILABLE, message: 'the opening response carried neither profile nor error', page: pageNo };
            available = false;
            break;
        }

        // Profile and photos exist on the first page only; a token call returns posts and
        // pagination, so later pages must not be read for them.
        if (isFirst) {
            profile = pickProfile(payload.profile);
            photos = Array.isArray(payload.photos) ? payload.photos : [];
        }
        // Any payload without an `error` means the page answered, even a resumed walk started
        // from a token that carried no profile.
        available = true;

        for (const post of pagePosts) if (isObject(post)) posts.push(post);
        postsByPage.push({ page: pageNo, status: 'data', posts: pagePosts.length });

        const nextToken = payload.pagination?.nextPageToken;
        if (!nonEmptyString(nextToken)) {
            pages.push({
                page: pageNo,
                kind: call.kind,
                status: PAGE_STATUS.END,
                posts: pagePosts.length,
                reason: null,
                nextPageToken: null,
                pagination: payload.pagination ?? null,
            });
            stop = { reason: STOP_REASON.FEED_END, message: 'the feed ended: the response carried no nextPageToken', page: pageNo };
            break;
        }

        if (seenTokens.has(nextToken)) {
            pages.push({
                page: pageNo,
                kind: call.kind,
                status: PAGE_STATUS.FAILED,
                posts: pagePosts.length,
                reason: { code: 'repeated_token', message: 'the API returned a token already used on this run' },
                nextPageToken: nextToken,
            });
            stop = { reason: STOP_REASON.REPEATED_TOKEN, message: 'the API returned a token already used on this run', page: pageNo };
            break;
        }

        pages.push({
            page: pageNo,
            kind: call.kind,
            status: PAGE_STATUS.SUBMITTED,
            posts: pagePosts.length,
            reason: null,
            nextPageToken: nextToken,
            pagination: payload.pagination ?? null,
        });

        seenTokens.add(nextToken);
        token = nextToken;
        const nextPageNumber = payload.pagination?.nextPage;
        if (Number.isFinite(nextPageNumber)) {
            // `nextPage` is only a label; the walk is driven by the token. Record it for the
            // audit trail rather than acting on it.
            pages[pages.length - 1].nextPageLabel = nextPageNumber;
        }
    }

    const stats = computeStats(posts, { topPosts });
    stats.byPage = postsByPage;
    const profileAvailable = available === true;
    const lastToken = token ?? null;
    const finalStop = stop ?? { reason: STOP_REASON.MAX_PAGES, message: 'stopped' };
    // `ok` is the one flag a caller should branch on: the page answered and no page in the walk
    // failed. `max_pages` with data is a successful, deliberately bounded run.
    const ok =
        profileAvailable &&
        finalStop.reason !== STOP_REASON.CALL_FAILED &&
        finalStop.reason !== STOP_REASON.PAGE_UNAVAILABLE &&
        finalStop.reason !== STOP_REASON.REPEATED_TOKEN;

    return {
        tool: toolName,
        handle,
        language: language ?? null,
        startedAt,
        finishedAt: toISO(now ?? Date.now()),
        ok,
        available: profileAvailable, // false when the page is missing/private or the first call failed
        profile: profile ? pickProfile(profile) : null,
        photos,
        pages,
        stop: finalStop,
        posts,
        stats,
        calls: { ...calls, credits: calls.billable * 10 },
        // Enough to continue a walk that stopped early: pass `startToken: resume.token` with the
        // earlier result as `prior`. A page that answered with `error` and a feed that ended
        // have nothing left to resume.
        resume: {
            handle,
            language: language ?? null,
            token:
                finalStop.reason === STOP_REASON.FEED_END || finalStop.reason === STOP_REASON.PAGE_UNAVAILABLE || finalStop.reason === STOP_REASON.REPEATED_TOKEN
                    ? null
                    : lastToken,
            nextPage: pages.filter((page) => page.status === PAGE_STATUS.SUBMITTED).length
                ? (pages.filter((page) => page.status === PAGE_STATUS.SUBMITTED).at(-1).pagination?.nextPage ?? null)
                : null,
            stoppedAtPage: pageNo,
        },
    };
}

/** Human-readable rendering of a snapshot: the page record, the feed and every page outcome. */
export function formatSnapshotReport(snapshot) {
    const lines = [];
    const name = snapshot.profile?.name ?? snapshot.profile?.username ?? snapshot.handle;
    lines.push(`# Facebook snapshot: ${name}`);
    lines.push('');
    if (!snapshot.available) {
        lines.push(`**Page unavailable.** ${snapshot.stop.message}`);
        lines.push('');
    } else if (snapshot.stop.reason === STOP_REASON.CALL_FAILED) {
        lines.push(`**Walk stopped early.** ${snapshot.stop.message}`);
        lines.push('');
    }
    if (snapshot.profile) {
        const p = snapshot.profile;
        const num = (v) => (typeof v === 'number' ? String(v) : v ?? '—');
        lines.push(`- Handle: ${snapshot.handle}`);
        lines.push(`- Name: ${p.name ?? '—'}`);
        lines.push(`- Category: ${p.category ?? '—'}`);
        lines.push(`- Likes: ${num(p.likesCount)} · Talking about: ${num(p.talkingAboutCount)} · Check-ins: ${num(p.checkInsCount)}`);
        lines.push(`- Followers: ${p.followersCount ?? '—'} · Following: ${p.followingCount ?? '—'}`);
        if (p.websiteUrl || p.website) lines.push(`- Website: ${p.websiteUrl ?? p.website}`);
        if (p.phone) lines.push(`- Phone: ${p.phone}`);
        if (p.owner?.name) lines.push(`- Owner: ${p.owner.name}${p.owner.isConfirmed ? ' (confirmed)' : ''}`);
        lines.push(`- Photos captured: ${snapshot.photos.length}`);
        lines.push('');
    }
    const { stats } = snapshot;
    lines.push('## Feed');
    lines.push(`- Posts collected: ${stats.postsCollected}`);
    const cadence = stats.cadence;
    if (cadence.postsPerDay !== null) {
        lines.push(`- Cadence: ${cadence.postsPerDay} posts/day across ${cadence.spanDays} day(s); median gap ${cadence.medianGapHours} h`);
    } else if (stats.postsCollected === 1) {
        lines.push('- Cadence: only one post observed, too few to measure a rate');
    } else {
        lines.push('- Cadence: no usable timestamps in the collected posts');
    }
    lines.push(`- Totals: ${stats.totals.reactions} reactions, ${stats.totals.comments} comments, ${stats.totals.shares} shares`);
    lines.push('');
    if (stats.topPosts.length) {
        lines.push('## Highest-engagement posts');
        for (const post of stats.topPosts) {
            const text = (post.text ?? '(no text)').replace(/\s+/g, ' ').slice(0, 100);
            lines.push(
                `${post.rank}. ${post.timestamp ?? 'undated'} — ${post.engagementTotal} interactions ` +
                    `(${post.reactionsCount} reactions, ${post.commentsCount} comments, ${post.sharesCount} shares): ${text}`,
            );
        }
        lines.push('');
    }
    lines.push('## Pages');
    for (const page of snapshot.pages) {
        const label = page.page === 'prior' ? 'prior' : `page ${page.page}`;
        const reason = page.reason?.message ? ` — ${page.reason.code}: ${page.reason.message}` : '';
        lines.push(`- ${label} (${page.kind}): ${page.status}, ${page.posts} post(s)${reason}`);
    }
    lines.push('');
    lines.push('## Calls');
    lines.push(`- Billable calls: ${snapshot.calls.billable} (${snapshot.calls.billable * 10} credits)`);
    lines.push(`- Total attempts: ${snapshot.calls.attempts} (${snapshot.calls.retries} retries)`);
    lines.push(`- Stop reason: ${snapshot.stop.reason}${snapshot.stop.message ? ` — ${snapshot.stop.message}` : ''}`);
    if (snapshot.resume?.token) {
        lines.push(`- Resume token available: yes (next page ${snapshot.resume.nextPage ?? 'unknown'})`);
    }
    lines.push('');
    return lines.join('\n');
}

function toISO(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('now must be a valid date');
    return date.toISOString();
}
