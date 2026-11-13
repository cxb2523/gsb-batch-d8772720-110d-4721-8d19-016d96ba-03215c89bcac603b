// ---------------------------------------------------------------------------
// Collection outcome tracking
//
// Every analyze run produces a collection outcome: a per-query record of what
// the scraper actually managed to fetch, plus roll-up totals. It is returned
// alongside the analysis result and persisted with the query history so that a
// report can never be mistaken for a complete one when some queries failed.
// ---------------------------------------------------------------------------

/** Outcome of a single (deduplicated) search query in the scraping plan. */
export interface QueryOutcome {
  /** The exact, trimmed query text that was sent to Reddit search. */
  query: string;
  /** Whether the Decodo search call for this query completed without error. */
  success: boolean;
  /**
   * Number of posts this query contributed (the raw search result count
   * before cross-query deduplication, topic filtering and ranking).
   * Populated for successful queries; always 0 for failed ones.
   */
  postCount: number;
  /** Failure explanation. Present only when `success` is false. */
  error?: string;
}

/** Per-post outcome of the comment deep-dive step. */
export interface CommentCollectionStatus {
  /** Whether the comment thread scrape completed without error. */
  commentsFetched: boolean;
  /** Failure explanation. Present only when `commentsFetched` is false. */
  error?: string;
}

/** Roll-up of an entire analysis run's collection phase. */
export interface CollectionOutcome {
  /** Per-query outcomes, in execution order (deduplicated queries). */
  queryOutcomes: QueryOutcome[];
  /** Number of unique, non-empty queries taken from the plan. */
  totalQueries: number;
  /** Number of queries whose search call succeeded. */
  successfulQueries: number;
  /** Number of queries whose search call failed. */
  failedQueries: number;
  /** Number of posts that made the final, ranked selection for the report. */
  selectedPostCount: number;
}
