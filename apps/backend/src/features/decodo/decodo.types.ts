import type { CommentCollectionStatus } from '../tracker/collection-outcome.types';

export type DecodoTarget = 'universal' | 'reddit_subreddit' | 'reddit_post';

export interface DecodoScrapeRequest {
  target: DecodoTarget;
  url: string;
  locale?: string;
  headless?: 'html';
}

export interface DecodoScrapeResponse {
  status: number;
  url: string;
  content: unknown;
  target: DecodoTarget;
}

export type RedditTimeRange = 'day' | 'week' | 'month' | 'year';

// Forward declaration to avoid a circular import: the tracker feature owns the
// collection-outcome types, while the post shape lives here with the scraper.
import type { CommentCollectionStatus } from '../tracker/collection-outcome.types';

export interface RedditPost {
  id: string;
  title: string;
  subreddit: string;
  author: string;
  upvotes: number;
  commentCount: number;
  url: string;
  permalink: string;
  selftext: string;
  createdAt: number;
  /**
   * Outcome of the comment deep-dive for this post. Absent for posts that
   * were never deep-dived (only the top N posts are); when present, a failed
   * comment scrape is recorded here instead of being silently swallowed.
   */
  commentCollectionStatus?: CommentCollectionStatus;
}

export interface RedditComment {
  id: string;
  author: string;
  body: string;
  upvotes: number;
  permalink: string;
}

export interface RedditPostWithComments extends RedditPost {
  comments: RedditComment[];
}

export interface ScrapeSearchParams {
  query: string;
  timeRange: RedditTimeRange;
  limit?: number;
  /** Restrict search to these subreddits via Reddit's `subreddit:` operator */
  subreddits?: string[];
}

export interface ScrapeSubredditParams {
  subreddit: string;
  limit?: number;
}

export interface ScrapePostParams {
  subreddit: string;
  postId: string;
}
