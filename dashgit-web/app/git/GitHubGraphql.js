import { graphql } from "octokit/graphql"
import { gitHubAdapter } from "./GitHubAdapter.js"
import { log } from "./Log.js"
import { wiController } from "../WiController.js"
import { login } from "../login/Login.js"

/**
 * Core interface with the provider api (GitHub).
 * Al services and return a provider-independent model (using an adapter) to show in the UI.
 * See doc at Controller.js
 */
const gitHubGraphql = {

  getGraphQlApi: function (provider) {
    return graphql.defaults({
      headers: {
        authorization: `token ${login.getProviderToken(provider)}`,
      },
    });
  },

  /**
   * Gets the statuses by requesting the GraphQL api page by page.
   * Every page records its own outcome ("success", "empty" or "error"), the number of repositories collected
   * so far, if there are more pages and the cursor of the next page. This makes the collection resumable:
   * a query error stops the pagination, but the data collected by the previous pages is kept (it is returned
   * and, when pagedUpdate is set, also submitted to the ui) and the caller can continue from the recorded
   * cursor with a further call.
   *
   * @param resumeState optional state of a previous interrupted call: { cursor, collected, next_page }.
   *   The pagination object returned in a previous call can be passed as is (cursor and collected are used,
   *   next_page keeps the page numbering). The response returned by that call can be passed in its `data`
   *   property to merge the pages requested now with the ones already collected (if not set, only the pages
   *   requested now are returned). If no resumeState is given, the pagination starts from the first page.
   * @returns the merged GraphQL data (partial if the pagination was interrupted) with an additional
   *   `pagination` property: { pages, page, next_page, collected, has_next, cursor, remaining, error, failed_page }
   *   where each entry of pages is { page, size, after, outcome, count, collected, has_next, cursor, error }.
   *   `count` is the number of nodes returned by the page, `collected` the accumulated number (it does not grow
   *   for an empty page or an error page) and `has_next` in an error page means that the page must be requested
   *   again. At the collection level, `has_next` is true if the pagination is not complete (more pages to
   *   request or an interrupted pagination) and then `cursor` is the cursor to resume from (null starts over).
   */
  graphQlWithPagination: async function (provider, maxProjects, maxPageSize, userSpecRepos, includeAll, pagedUpdate, graphqlV2, resumeState) { // NOSONAR the arguments are the query parameters plus the resume state
    maxPageSize = Math.max(maxPageSize, 2); // ensure in a range
    maxPageSize = Math.min(maxPageSize, 50);
    const alreadyCollected = resumeState?.collected ?? 0;
    // data collected by a previous interrupted call (if any), the new pages are merged with it
    let allData = resumeState?.data ?? {};
    // page numbering: resumeState.next_page is the page to request, pages start at 1
    let page = Math.max((resumeState?.next_page ?? 1) - 1, 0);
    let remainingProjects = Math.max(maxProjects - alreadyCollected, 0); // do not request the already collected ones
    let hasNextPage = true;
    let endCursor = resumeState?.cursor ?? null;
    let collected = alreadyCollected;
    // nodes already submitted to the ui: the ones merged from a previous call are considered submitted
    let submittedNodes = allData.viewer?.repositories?.nodes.length ?? 0;
    // Submits the statuses of the partial model (all pages until now) to the ui
    const submitPartialUpdate = function () {
      const gqlresponse = gitHubAdapter.postprocessGraphQl(allData);
      const model = gitHubAdapter.statuses2model(provider, gqlresponse, graphqlV2);
      wiController.updateStatusesForPage(provider.uid, model); //direct call instead of using a callback
      submittedNodes = allData.viewer.repositories.nodes.length;
    };
    const pagination = {
      pages: [], // outcome of each requested page
      page: page, // number of the last page requested (allows resuming with this whole object)
      next_page: page + 1, // page to request when resuming
      collected: collected, // repositories collected, including the ones collected before resuming
      has_next: false, // true if the pagination is not completed (more pages or an error)
      cursor: null, // cursor to resume from the first page that has not been collected yet (null if none)
      remaining: remainingProjects, // requested repositories that have not been collected yet
      error: null, // message of the error that interrupted the pagination
      failed_page: null, // number of the page that failed
    };
    while (hasNextPage && remainingProjects > 0) {
      const pageSize = Math.min(remainingProjects, maxPageSize);
      const effectiveUserSpecRepos = endCursor == null ? userSpecRepos : ""; // only included in the first page
      const goal = includeAll ? "Get statuses" : "Get update reqs"
      log.debug(provider.uid, `${goal}, page ${++page}, page size ${pageSize}, remaining ${remainingProjects} ...`);
      const query = this.getStatusesQuery(provider, pageSize, effectiveUserSpecRepos, includeAll, endCursor, graphqlV2);
      // Each page outcome is recorded so that a failure does not lose the data collected by the previous pages
      const pageResult = {
        page: page, size: pageSize, after: endCursor, outcome: "", count: 0,
        collected: collected, has_next: false, cursor: null, error: null
      };
      const pageResponse = await this.getPageResponse(provider, query); // NOSONAR sequential by design: each page needs the endCursor of the previous one
      if (pageResponse.error != null) { // stop paginating, but keep the data collected until now
        pageResult.outcome = "error";
        pageResult.error = pageResponse.error;
        pageResult.has_next = true; // this page has to be requested again when resuming
        pageResult.cursor = endCursor; // resume from the same page
        pagination.pages.push(pageResult);
        pagination.error = pageResponse.error;
        pagination.failed_page = page;
        hasNextPage = true;
        break;
      }

      const response = pageResponse.response;
      if (allData.viewer == undefined) // first page
        allData = response;
      else
        allData.viewer.repositories.nodes.push(...response.viewer.repositories.nodes);

      // prepare for next page
      collected += response.viewer.repositories.nodes.length;
      remainingProjects -= pageSize;
      hasNextPage = response.viewer.repositories.pageInfo.hasNextPage;
      endCursor = response.viewer.repositories.pageInfo.endCursor;
      pageResult.outcome = response.viewer.repositories.nodes.length == 0 ? "empty" : "success";
      pageResult.count = response.viewer.repositories.nodes.length;
      pageResult.collected = collected;
      pageResult.has_next = hasNextPage;
      pageResult.cursor = endCursor;
      pagination.pages.push(pageResult);

      // if required, update the statuses of the partial model (all pages until now) to the ui
      // When handling last page, the ui will be fully updated by the caller.
      // When the pagination fails, the model of the pages collected before the error is submitted below.
      if (includeAll && pagedUpdate && remainingProjects > 0 && hasNextPage)
        submitPartialUpdate();
    }

    pagination.page = page;
    // when the pagination was interrupted, the failed page must be requested again
    pagination.next_page = pagination.error != null ? pagination.failed_page : page + 1;
    pagination.collected = collected;
    pagination.remaining = remainingProjects;
    pagination.has_next = pagination.error != null || (hasNextPage && remainingProjects > 0);
    pagination.cursor = pagination.has_next ? endCursor : null;
    allData.pagination = pagination;
    // The pages collected before the error must still be displayed, they are never discarded as a whole:
    // if their nodes have not been submitted to the ui yet, submit their model now
    if (pagination.error != null && includeAll && pagedUpdate
      && allData.viewer?.repositories.nodes.length > submittedNodes)
      submitPartialUpdate();
    return allData;
  },

  // Requests a page of the statuses query. Returns { response } on success or { error } with the message
  // of the failure: either the request throws or the GraphQL response reports errors or lacks the data.
  getPageResponse: async function (provider, query) {
    try {
      const response = await this.getGraphQlApi(provider)(query);
      if (response?.errors?.length > 0)
        return { error: response.errors.map(e => e?.message ?? JSON.stringify(e)).join("; ") };
      if (response?.viewer?.repositories?.nodes == undefined)
        return { error: "The GraphQL response does not contain the repositories nodes" };
      return { response: response };
    } catch (error) {
      return { error: error?.message ?? String(error) };
    }
  },

  getStatusesQuery: function (provider, maxProjects, userSpecRepos, includeAll, cursor, graphqlV2) {
    let affiliations = provider.graphql.ownerAffiliations.toString();
    let forks = "isFork:false, ";
    if (provider.graphql.includeForks)
      forks = "";
    else if (provider.graphql.onlyForks)
      forks = "isFork:true, ";
    return `{
      viewer {
        login, resourcePath, url, repositories(first: ${maxProjects}, ownerAffiliations: [${affiliations}], 
        after: ${cursor == null ? "null" : `"${cursor}"`},
        ${forks} isArchived:false, orderBy: {field: PUSHED_AT, direction: DESC}) {
          nodes {
            name, nameWithOwner, url, pushedAt
            ${includeAll ? this.getReposSubquery(provider, graphqlV2) : ""}
          }
          pageInfo {
            hasNextPage, endCursor
          }
        }
      }
      ${graphqlV2 ? this.getUserSpecReposSubquery(provider, userSpecRepos, includeAll) : ""}
    }`;
  },
  getReposSubquery: function (provider, graphqlV2) {
    return `
    ${graphqlV2 ? this.getPullRequestsNode(provider) : ``}
    ${this.getRefsNode(provider)}
    `;
  },
  getPullRequestsNode: function (provider) {
    return `
    pullRequests(first: ${provider.graphql.maxBranches}, states:[OPEN], orderBy: {field:UPDATED_AT, direction:DESC}) 
      { edges { node { title, number, url, state, createdAt, updatedAt,
        headRefName, baseRepository {nameWithOwner}, headRepository {nameWithOwner}, 
        statusCheckRollup { state } } } }`;
  },
  getRefsNode: function (provider, graphqlV2) {
    return `
    refs(refPrefix: "refs/heads/", first: ${provider.graphql.maxBranches}) {
      nodes {
        name
        target {
          ... on Commit {
            ${graphqlV2 ? `` : `
            associatedPullRequests(first: 1) {
              edges {  node { title, number, url, state, createdAt, updatedAt } }
            }
            `}
            history(first: 1) { 
              nodes { messageHeadline, committedDate, statusCheckRollup { state } } 
            }
          }
        }
      }
    }`;
  },
  // Query the pending review requests of a set of PRs, one aliased repository/pullRequest block each
  // (prs = [{ owner, repo, number, alias }]). Used to decide whether the author's "changes requested"
  // badge should be muted (a re-review is pending). Does not depend on GraphQL node ids.
  getReviewRequestsQuery: function (prs) {
    return `{
      ${prs.map(p => `${p.alias}: repository(owner: "${p.owner}", name: "${p.repo}") {
        pullRequest(number: ${p.number}) {
          number
          reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        }
      }`).join("\n      ")}
    }`;
  },
  getUserSpecReposSubquery: function (provider, reposStr, includeAll) {
    if (reposStr == undefined)
      return "";
    let repos = reposStr.split(" ");
    let query = "";
    let i = 0;
    for (let item of repos) {
      if (item == "")
        continue;
      const repoAlias = "xr" + i;
      const repoAll = item.split("/");
      const owner = repoAll[0];
      const repo = repoAll.length < 2 ? "" : repoAll[1];
      query += `
    ${repoAlias}:repository(owner:"${owner}", name:"${repo}") {
      name, nameWithOwner, url, pushedAt, updatedAt
      ${includeAll ? this.getPullRequestsNode(provider) : ""}
    }`;
      i++;
    }
    return query
  },

}

export { gitHubGraphql };
