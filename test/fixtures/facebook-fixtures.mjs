// Local fixtures for the snapshot tests.
//
// These are hand-written responses shaped like the hosted Facebook tool's payload, never a
// recording of a billed call. Nothing here reaches the network: `fakeClient` replays the queue
// synchronously and records every request so a test can assert how many calls were spent and
// which token was passed.

export const PROFILE = {
    id: '100044541544829',
    pageId: '15087023444',
    name: 'Nike',
    username: 'nike',
    url: 'https://www.facebook.com/nike',
    category: 'Sportswear Store',
    biography: 'Just Do It.',
    likesCount: 39545204,
    talkingAboutCount: 173971,
    checkInsCount: 18299,
    followersCount: '39M followers',
    followingCount: '24 following',
    verified: true,
    website: 'nike.com',
    websiteUrl: 'http://nike.com/',
    phone: '+48 58 881 27 61',
    owner: { name: 'NIKE, Inc.', isConfirmed: true },
    profilePicUrl: 'https://example.invalid/pic.jpg',
    coverPhotoUrl: 'https://example.invalid/cover.jpg',
};

export const PHOTOS = [
    { id: 'photo-1', type: 'Photo', image: 'https://example.invalid/photo-1.jpg' },
    { id: 'photo-2', type: 'Photo', image: 'https://example.invalid/photo-2.jpg' },
];

function post(id, timestamp, overrides = {}) {
    return {
        id,
        url: `https://www.facebook.com/reel/${id}/`,
        text: `Post ${id}`,
        hashtags: [],
        timestamp,
        reactionsCount: 100,
        commentsCount: 10,
        sharesCount: 1,
        reactions: [{ type: 'Like', count: 100 }],
        media: [],
        ...overrides,
    };
}

// A page whose feed takes three pages: one post on page one, then three on each token call.
export const THREE_PAGE_FEED = {
    first: {
        profile: PROFILE,
        posts: [post('p1', '2025-09-15T16:00:00.000Z', { reactionsCount: 7_885, commentsCount: 2_461, sharesCount: 1_124 })],
        photos: PHOTOS,
        pagination: { postsPerPage: 3, nextPage: 2, nextPageToken: 'token-2' },
    },
    second: {
        // No profile and no photos: a token call returns posts and pagination only.
        posts: [
            post('p2', '2025-09-14T16:00:00.000Z', { reactionsCount: 500, commentsCount: 20, sharesCount: 5 }),
            post('p3', '2025-09-13T16:00:00.000Z', { reactionsCount: 90, commentsCount: 4, sharesCount: 0 }),
            post('p4', '2025-09-12T16:00:00.000Z', { reactionsCount: 1_200, commentsCount: 80, sharesCount: 30 }),
        ],
        pagination: { postsPerPage: 3, nextPage: 3, nextPageToken: 'token-3' },
    },
    third: {
        posts: [
            post('p5', '2025-09-11T16:00:00.000Z', { reactionsCount: 10, commentsCount: 1, sharesCount: 0 }),
            post('p6', '2025-09-10T16:00:00.000Z', { reactionsCount: 20, commentsCount: 2, sharesCount: 0 }),
            post('p7', '2025-09-09T16:00:00.000Z', { reactionsCount: 30, commentsCount: 3, sharesCount: 1 }),
        ],
        pagination: { postsPerPage: 3, nextPage: 4 },
    },
};

// A page that exists but has published exactly one post; the feed ends on the opening call.
export const ONE_POST_FEED = {
    first: {
        profile: PROFILE,
        posts: [post('only-1', '2025-09-15T16:00:00.000Z')],
        photos: PHOTOS,
        pagination: { postsPerPage: 3, nextPage: 2 },
    },
};

// The shape the API answers 200 with for a missing, deleted or non-public page.
export const PAGE_ERROR_PAYLOAD = {
    error: {
        code: 'not_found',
        message: 'The page does not exist, was deleted or is not public.',
    },
};

/**
 * A client whose responses are a queue of fixture payloads.
 *
 * Each queue item is one of:
 *   { payload }                       a successful tool result
 *   { error: Error }                  the tool call throws (e.g. retry exhaustion)
 *
 * The returned object also exposes `requests`, one entry per `call()`, and `tokenOf(i)`.
 */
export function fakeClient(queue) {
    const requests = [];
    let index = 0;
    return {
        requests,
        async call(args) {
            requests.push({ ...args });
            if (index >= queue.length) throw new Error(`fixture queue exhausted after ${queue.length} call(s)`);
            const item = queue[index++];
            if (item.error) throw item.error;
            return { payload: item.payload, attempts: item.attempts ?? 1, billed: item.billed ?? true };
        },
        get remaining() {
            return queue.length - index;
        },
    };
}

/** A client that always throws the same error, to model a throttle that never clears. */
export function failingClient(error) {
    const requests = [];
    return {
        requests,
        async call(args) {
            requests.push({ ...args });
            throw error;
        },
    };
}
