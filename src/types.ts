export interface ParseOptions {
  language?: string
  includeLlmsTxt?: boolean
  /** For aggregate URLs (e.g. x.com profiles): max items to include. */
  limit?: number
  /** For aggregate URLs: chronological order within the fetched window. */
  order?: "newest" | "oldest"
  /**
   * Allow requests to private, loopback, link-local and ULA addresses.
   * Defaults to `false` to prevent SSRF when `rdrr` is exposed as a service.
   */
  allowPrivateNetworks?: boolean
  /**
   * GitHub API token for issue/PR/file requests. Falls back to `process.env.GITHUB_TOKEN`.
   * Use a fine-grained token with `public_repo` read scope for most cases.
   */
  githubToken?: string
  /** Words-per-minute for `readTime` estimation. Defaults to 200. */
  wordsPerMinute?: number
  /** Abort signal forwarded to every underlying fetch. */
  signal?: AbortSignal
  /** Timeout in ms: default 25000 per request, or 120000 for the complete Reddit operation. */
  timeoutMs?: number
  /** Override the outbound User-Agent header. */
  userAgent?: string
}

export interface ParseResult {
  nextPageUrl?: string
  type: "youtube" | "webpage" | "github" | "stackoverflow" | "x-profile" | "x-status"
  title: string
  author: string
  content: string
  description: string
  domain: string
  siteName: string
  language?: string
  dir?: "ltr" | "rtl"
  published: string | null
  wordCount: number
  readTime: string
  llmsTxt?: string
}

export interface Chapter {
  title: string
  startTime: number
  formattedTime: string
}

export interface TranscriptSegment {
  text: string
  startTime: number
  endTime: number
  formattedTime: string
  speaker?: string
  chapterIndex: number
}

export interface YouTubeResult extends ParseResult {
  type: "youtube"
  videoId: string
  thumbnailUrl: string | null
  chapters: Chapter[]
  transcript: TranscriptSegment[]
  isLyric: boolean
}

export interface RedirectRecord {
  /** URL that responded with a redirect. */
  from: string
  /** URL the redirect pointed at, after resolving a relative Location header. */
  to: string
  /** HTTP status code of the redirect response (3xx). */
  status: number
}

export interface WebpageResult extends ParseResult {
  type: "webpage"
  /** Every redirect followed to reach the final response, in order. Empty when none occurred. */
  redirects: RedirectRecord[]
  /** URL of the final response. Equals the request URL when no redirect occurred. */
  finalUrl: string
}

export interface GitHubResult extends ParseResult {
  type: "github"
}

export interface StackOverflowResult extends ParseResult {
  type: "stackoverflow"
  questionId: string
  score: number
  isAnswered: boolean
}

export interface XProfileResult extends ParseResult {
  type: "x-profile"
  handle: string
  postCount: number
}

export interface XStatusResult extends ParseResult {
  type: "x-status"
  handle: string
  statusId: string
  /** Which upstream strategy produced the result (e.g. "fxtwitter", "syndication"). */
  source: string
}

export type ParsedResult =
  | YouTubeResult
  | WebpageResult
  | GitHubResult
  | StackOverflowResult
  | XProfileResult
  | XStatusResult
