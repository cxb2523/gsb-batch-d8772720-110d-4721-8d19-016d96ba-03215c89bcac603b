import { describe, expect, test } from "vitest";
import {
  createGitHubUserDataFetcherWithMetrics,
  GitHubApiError,
  type GitHubFetcherDependencies,
} from "@/lib/github";

type ExecuteCall = {
  operationName: string;
};

type ExecutorBehavior = {
  failPullRequests?: unknown;
  failIssues?: unknown;
  failDiscussions?: unknown;
  failUser?: unknown;
  nullUser?: boolean;
};

function makeExecutor(
  calls: ExecuteCall[],
  behavior: ExecutorBehavior = {},
): GitHubFetcherDependencies["executor"] {
  return {
    async execute<TData, TVariables extends Record<string, unknown>>(params: {
      operationName: string;
      query: string;
      variables: TVariables;
    }): Promise<TData> {
      calls.push({ operationName: params.operationName });

      if (params.operationName === "FetchUser") {
        if (behavior.failUser) {
          throw behavior.failUser;
        }
        return {
          user: behavior.nullUser
            ? null
            : {
                login: "testuser",
                name: "User Name",
                avatarUrl: "https://example.com/avatar.png",
                location: null,
                repositories: { nodes: [] },
                contributionsCollection: {
                  totalCommitContributions: 0,
                  totalPullRequestContributions: 0,
                  totalIssueContributions: 0,
                },
              },
        } as unknown as TData;
      }

      if (params.operationName === "FetchUserPullRequests") {
        if (behavior.failPullRequests) {
          throw behavior.failPullRequests;
        }
        return {
          pullRequests: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        } as unknown as TData;
      }

      if (params.operationName === "FetchUserIssues") {
        if (behavior.failIssues) {
          throw behavior.failIssues;
        }
        return {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        } as unknown as TData;
      }

      if (params.operationName === "FetchUserDiscussions") {
        if (behavior.failDiscussions) {
          throw behavior.failDiscussions;
        }
        return {
          discussions: {
            nodes: [
              {
                title: "Discussion",
                url: "https://github.com/ext/repo/discussions/1",
                comments: { totalCount: 1 },
                repository: {
                  nameWithOwner: "ext/repo",
                  stargazerCount: 40,
                  owner: { login: "ext" },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        } as unknown as TData;
      }

      throw new Error(`Unexpected operation: ${params.operationName}`);
    },
  };
}

function makeFetcher(
  calls: ExecuteCall[],
  behavior: ExecutorBehavior = {},
): ReturnType<typeof createGitHubUserDataFetcherWithMetrics> {
  return createGitHubUserDataFetcherWithMetrics({
    executor: makeExecutor(calls, behavior),
    cacheStore: {
      enabled: false,
      async get() {
        return undefined;
      },
      async set() {},
    },
    cacheConfig: { namespace: "test", ttlSeconds: 60 },
    logger: { info() {}, warn() {} },
  });
}

describe("GitHub user data partial failures", () => {
  test("failed PR and issue queries degrade to empty sets with classified missing parts", async () => {
    const calls: ExecuteCall[] = [];
    const fetcher = makeFetcher(calls, {
      failPullRequests: new GitHubApiError({
        message: "You have exceeded a secondary rate limit",
        kind: "SECONDARY_RATE_LIMIT",
        status: 403,
        rateLimit: { retryAfterSeconds: 30 },
        retryAfterMs: 30_000,
      }),
      failIssues: new GitHubApiError({
        message: "API rate limit exceeded",
        kind: "PRIMARY_RATE_LIMIT",
        status: 403,
        rateLimit: { remaining: 0 },
      }),
    });

    const { data, metrics } = await fetcher("testuser");

    // Score-relevant data still computed: failures degrade to empty sets
    expect(data.pullRequests).toEqual([]);
    expect(data.issues).toEqual([]);
    expect(data.discussions).toHaveLength(1);

    // Missing parts carry classification + retry hints
    expect(data.missingParts).toHaveLength(2);
    const prMissing = data.missingParts?.find((m) => m.part === "pullRequests");
    expect(prMissing).toMatchObject({
      kind: "SECONDARY_RATE_LIMIT",
      retriable: true,
      retryAfterSeconds: 30,
    });
    const issueMissing = data.missingParts?.find((m) => m.part === "issues");
    expect(issueMissing).toMatchObject({
      kind: "PRIMARY_RATE_LIMIT",
      retriable: true,
    });

    // Metrics errors carry the same classification
    const prError = metrics.errors.find((e) => e.part === "pullRequests");
    expect(prError).toMatchObject({ kind: "SECONDARY_RATE_LIMIT", retriable: true });
    const issueError = metrics.errors.find((e) => e.part === "issues");
    expect(issueError).toMatchObject({ kind: "PRIMARY_RATE_LIMIT" });
  });

  test("non-GitHub failures are classified as UNKNOWN and not retriable", async () => {
    const calls: ExecuteCall[] = [];
    const fetcher = makeFetcher(calls, {
      failDiscussions: new Error("socket hang up"),
    });

    const { data } = await fetcher("testuser");

    expect(data.discussions).toEqual([]);
    expect(data.missingParts).toEqual([
      expect.objectContaining({
        part: "discussions",
        kind: "UNKNOWN",
        retriable: false,
        reason: "socket hang up",
      }),
    ]);
  });

  test("complete collection has no missingParts marker", async () => {
    const calls: ExecuteCall[] = [];
    const fetcher = makeFetcher(calls);

    const { data, metrics } = await fetcher("testuser");

    expect(data.missingParts).toBeUndefined();
    expect(metrics.errors).toEqual([]);
  });

  test("user query failure still throws and is not degraded", async () => {
    const calls: ExecuteCall[] = [];
    const failure = new GitHubApiError({
      message: "Bad credentials",
      kind: "AUTH",
      status: 401,
      rateLimit: {},
    });
    const fetcher = makeFetcher(calls, { failUser: failure });

    await expect(fetcher("testuser")).rejects.toBe(failure);
  });

  test("empty user result still throws 'User not found'", async () => {
    const calls: ExecuteCall[] = [];
    const fetcher = makeFetcher(calls, { nullUser: true });

    await expect(fetcher("testuser")).rejects.toThrow("User not found");
  });
});
