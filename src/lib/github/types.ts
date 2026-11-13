import type { GitHubErrorKind } from "./github-graphql-client";

export type RepoLanguageEdge = {
  size: number;
  node: {
    name: string;
  };
};

export type RepoLanguages = {
  edges: RepoLanguageEdge[];
};

type CommunityRepositoryNode = {
  nameWithOwner: string;
  stargazerCount: number;
  owner: { login: string };
};

export type IssueNode = {
  title: string;
  url?: string;
  comments: { totalCount: number };
  repository: CommunityRepositoryNode;
};

export type DiscussionNode = {
  title: string;
  url?: string;
  comments: { totalCount: number };
  repository: CommunityRepositoryNode;
};

export type RepoNode = {
  name: string;
  nameWithOwner?: string;
  url?: string;
  isFork?: boolean;
  stargazerCount: number;
  forkCount: number;
  watchers: { totalCount: number };
  pushedAt?: string;
  languages?: RepoLanguages;
};

export type PullRequestNode = {
  merged: boolean;
  additions: number;
  deletions: number;
  title: string;
  url?: string;
  repository: {
    nameWithOwner: string;
    url?: string;
    stargazerCount: number;
    pushedAt?: string;
    owner: { login: string };
    languages?: RepoLanguages;
  };
};

/**
 * A contribution sub-query that may fail independently of the main user query.
 */
export type GitHubDataPart = "pullRequests" | "issues" | "discussions";

/**
 * Classification of a failed sub-query, carried alongside the (degraded)
 * result so callers can distinguish "no contributions" from "not fetched".
 */
export type MissingDataInfo = {
  part: GitHubDataPart;
  kind: GitHubErrorKind;
  retriable: boolean;
  retryAfterSeconds?: number;
  reason: string;
};

export type GitHubUserData = {
  login: string;
  name: string | null;
  avatarUrl: string;
  location: string | null;
  repos: RepoNode[];
  pullRequests: PullRequestNode[];
  issues?: IssueNode[];
  discussions?: DiscussionNode[];
  /**
   * Present when one or more contribution sub-queries failed and were
   * degraded to empty collections. Absent (or empty) means the data is
   * complete — empty arrays then genuinely mean "no contributions".
   */
  missingParts?: MissingDataInfo[];
};
