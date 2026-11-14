import { describe, it, expect, vi } from 'vitest';

import {
  scrapeListingEntries,
  type ListingLogger,
  type ListingPageFilter,
  type ListingPageOutcome,
  type ListingPageScraperOptions,
} from './scrapeListing.js';

const createMockLog = (): ListingLogger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
});

type Ctx = { actorName?: string };
type Outcome = ListingPageOutcome<Ctx, string>;

const createOptions = (
  overrides: Partial<ListingPageScraperOptions<Ctx, string>> = {}
): ListingPageScraperOptions<Ctx, string> => ({
  context: {},
  startUrls: ['https://example.com/listing'],
  log: createMockLog(),
  nextPageWait: 0,
  extractEntries: async () => [],
  ...overrides,
});

describe('scrapeListingEntries', () => {
  describe('onPageOutcome', () => {
    it('reports success for pages followed by another page, and pagination-failed when onGoToNextPage throws', async () => {
      const outcomes: Outcome[] = [];
      const goToNextPageError = new Error('No more pages');
      const pages = [['https://example.com/a', 'https://example.com/b'], ['https://example.com/c']];
      let goToNextPageCalls = 0;

      const links = await scrapeListingEntries(
        createOptions({
          extractEntries: async (_ctx, _retryIndex) => pages.shift() ?? [],
          onGoToNextPage: async () => {
            goToNextPageCalls++;
            if (goToNextPageCalls > 1) throw goToNextPageError;
          },
          onPageOutcome: (outcome) => {
            outcomes.push(outcome);
          },
        })
      );

      // Returned links are unchanged in content and order
      expect(links).toEqual([
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c',
      ]);

      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]).toMatchObject({
        startUrl: 'https://example.com/listing',
        pageIndex: 1,
        entryCount: 2,
        outcome: 'success',
      });
      expect(outcomes[0].error).toBeUndefined();
      expect(outcomes[1]).toMatchObject({
        startUrl: 'https://example.com/listing',
        pageIndex: 2,
        entryCount: 1,
        outcome: 'pagination-failed',
      });
      expect(outcomes[1].error).toBe(goToNextPageError);
      // The outcome exposes the scraper context
      expect(outcomes[0].context.startUrl).toBe('https://example.com/listing');
      expect(typeof outcomes[0].context.abort).toBe('function');
    });

    it('reports success for a single-page listing without onGoToNextPage', async () => {
      const outcomes: Outcome[] = [];

      const links = await scrapeListingEntries(
        createOptions({
          extractEntries: async () => ['https://example.com/a'],
          onPageOutcome: (outcome) => {
            outcomes.push(outcome);
          },
        })
      );

      expect(links).toEqual(['https://example.com/a']);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        pageIndex: 1,
        entryCount: 1,
        outcome: 'success',
      });
    });

    it('reports aborted when the caller aborts during extraction', async () => {
      const outcomes: Outcome[] = [];
      const onGoToNextPage = vi.fn();

      const links = await scrapeListingEntries(
        createOptions({
          extractEntries: async (ctx) => {
            ctx.abort();
            return ['https://example.com/a'];
          },
          onGoToNextPage,
          onPageOutcome: (outcome) => {
            outcomes.push(outcome);
          },
        })
      );

      expect(links).toEqual(['https://example.com/a']);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        pageIndex: 1,
        entryCount: 1,
        outcome: 'aborted',
      });
      expect(onGoToNextPage).not.toHaveBeenCalled();
    });

    it('reports count-only in listingCountOnly mode', async () => {
      const outcomes: Outcome[] = [];

      const links = await scrapeListingEntries(
        createOptions({
          listingCountOnly: true,
          extractEntries: async () => ['https://example.com/a', 'https://example.com/b'],
          onPageOutcome: (outcome) => {
            outcomes.push(outcome);
          },
        })
      );

      expect(links).toEqual(['https://example.com/a', 'https://example.com/b']);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        pageIndex: 1,
        entryCount: 2,
        outcome: 'count-only',
      });
    });

    it('reports filters-failed when filter loading exhausts retries, and continues with the next filter combination', async () => {
      const outcomes: Outcome[] = [];
      const filterLoadError = new Error('Filter failed to load');
      const onLoadFiltersError = vi.fn();

      let nextStateCalls = 0;
      let loadAttempts = 0;
      const filter: ListingPageFilter = {
        name: 'flaky-filter',
        initState: () => false,
        resetState: () => {},
        nextState: () => {
          nextStateCalls++;
        },
        // Two combinations: after the first nextState() there's still one more state
        hasNextState: () => nextStateCalls < 2,
        hasState: () => true,
        loadState: () => {
          loadAttempts++;
          if (loadAttempts === 1) throw filterLoadError;
        },
      };

      const links = await scrapeListingEntries(
        createOptions({
          filters: [filter],
          loadFiltersRetries: 0,
          onLoadFiltersError,
          extractEntries: async () => ['https://example.com/a'],
          onPageOutcome: (outcome) => {
            outcomes.push(outcome);
          },
        })
      );

      // The failed combination was retried (and reported via onLoadFiltersError)...
      expect(onLoadFiltersError).toHaveBeenCalledTimes(1);
      // ...recorded as a failed outcome carrying the error...
      expect(outcomes[0]).toMatchObject({
        startUrl: 'https://example.com/listing',
        pageIndex: 0,
        entryCount: null,
        outcome: 'filters-failed',
      });
      expect(outcomes[0].error).toBe(filterLoadError);
      // ...and processing continued with the next filter combination instead of
      // interrupting the whole run
      expect(outcomes).toHaveLength(2);
      expect(outcomes[1]).toMatchObject({
        startUrl: 'https://example.com/listing',
        pageIndex: 1,
        entryCount: 1,
        outcome: 'success',
      });
      expect(links).toEqual(['https://example.com/a']);
    });

    it('continues with the next startUrl after a filter combination fails', async () => {
      const outcomes: Outcome[] = [];
      let loadAttempts = 0;
      const filter: ListingPageFilter = {
        name: 'flaky-filter',
        initState: () => false,
        resetState: () => {},
        nextState: () => {},
        hasNextState: () => false,
        hasState: () => true,
        loadState: () => {
          loadAttempts++;
          // Fail only while processing the first startUrl
          if (loadAttempts === 1) throw new Error('Filter failed to load');
        },
      };

      const links = await scrapeListingEntries(
        createOptions({
          startUrls: ['https://example.com/listing-1', 'https://example.com/listing-2'],
          filters: [filter],
          loadFiltersRetries: 0,
          onLoadFiltersError: () => {},
          extractEntries: async (ctx) => [`${ctx.startUrl}/entry`],
          onPageOutcome: (outcome) => {
            outcomes.push(outcome);
          },
        })
      );

      expect(outcomes.map((o) => [o.startUrl, o.outcome])).toEqual([
        ['https://example.com/listing-1', 'filters-failed'],
        ['https://example.com/listing-2', 'success'],
      ]);
      expect(links).toEqual(['https://example.com/listing-2/entry']);
    });

    it('behaves the same as before when onPageOutcome is not provided', async () => {
      const links = await scrapeListingEntries(
        createOptions({
          extractEntries: async () => ['https://example.com/a'],
          onGoToNextPage: async () => {
            throw new Error('No more pages');
          },
        })
      );

      expect(links).toEqual(['https://example.com/a']);
    });
  });
});
