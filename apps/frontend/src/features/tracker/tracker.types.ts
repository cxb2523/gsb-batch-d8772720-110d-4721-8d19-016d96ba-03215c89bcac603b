export type TimeRange = 'day' | 'week' | 'month' | 'year';

export interface ScrapingPlan {
  subreddits: string[];
  queries: string[];
  timeRange: TimeRange;
  rationale: string;
}

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
  commentCollectionStatus?: CommentCollectionStatus;
}

/** Outcome of a single (deduplicated) search query during collection. */
export interface QueryOutcome {
  query: string;
  success: boolean;
  postCount: number;
  error?: string;
}

/** Per-post outcome of the comment deep-dive step. */
export interface CommentCollectionStatus {
  commentsFetched: boolean;
  error?: string;
}

/** Roll-up of an analysis run's collection phase, mirroring the backend type. */
export interface CollectionOutcome {
  queryOutcomes: QueryOutcome[];
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  selectedPostCount: number;
}

export interface RedditReport {
  executiveSummary: string;
  themes: Array<{ title: string; description: string }>;
  sentiment: {
    overall: 'positive' | 'negative' | 'neutral' | 'mixed';
    rationale: string;
  };
  notableQuotes: Array<{ text: string; subreddit: string; url: string }>;
  topPosts: Array<{
    title: string;
    subreddit: string;
    upvotes: number;
    commentCount: number;
    url: string;
  }>;
}

export interface AnalyzeResult {
  id: string;
  plan: {
    prompt: string;
    subreddits: string[];
    queries: string[];
    timeRange: TimeRange;
  };
  posts: RedditPost[];
  report: RedditReport;
  collectionOutcome: CollectionOutcome;
}

export interface StoredQuery {
  _id: string;
  prompt: string;
  plan: ScrapingPlan;
  posts?: RedditPost[];
  report: RedditReport;
  collectionOutcome?: CollectionOutcome;
  createdAt: string;
}
