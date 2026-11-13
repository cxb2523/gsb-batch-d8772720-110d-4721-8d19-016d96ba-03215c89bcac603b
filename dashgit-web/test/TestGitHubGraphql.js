// The app is not built: its dependencies are resolved by the importmap of index.html from a CDN.
// Node can't resolve the bare specifiers below, so they are replaced by minimal stubs before importing
// the module under test. The GraphQL api itself is always replaced by a fake in each test.
import { registerHooks } from "node:module";

const STUBS = {
  "octokit/graphql": `export const graphql = { defaults: () => async () => ({}) };`,
  "octokit/rest": `export class Octokit {}`,
  "gitbeaker/rest": `export class Gitlab {}`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBS[specifier] != undefined)
      return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

import assert from 'assert';
import sinon from 'sinon';

// The imports of the app module are dynamic (after the hooks are registered) because the static imports
// would be resolved before the stubs of the browser libs are in place.
const { gitHubGraphql } = await import("../app/git/GitHubGraphql.js");
const { wiController } = await import("../app/WiController.js");

const provider = {
  provider: "GitHub", uid: "0-github", user: "usr1",
  graphql: { ownerAffiliations: ["OWNER"], maxBranches: 2 },
};

// Creates a node of the GraphQL response: only the fields used by the query and by the adapter are needed.
// Each repo has a single branch so that the conversion to the model produces one item per repository.
function repoNode(name) {
  return {
    name: name, nameWithOwner: `owner/${name}`, url: `https://github.com/owner/${name}`, pushedAt: "2024-12-09T14:00:00Z",
    pullRequests: { edges: [] },
    refs: {
      nodes: [{
        name: "main",
        target: { history: { nodes: [{ messageHeadline: `commit of ${name}`, committedDate: "2024-12-09T13:00:00Z", statusCheckRollup: { state: "SUCCESS" } }] } }
      }]
    }
  };
}
function page(nodes, hasNextPage, endCursor) {
  return { viewer: { repositories: { nodes: nodes, pageInfo: { hasNextPage: hasNextPage, endCursor: endCursor } } } };
}
function errorPage(messages) {
  return { errors: messages.map(message => ({ message: message })) };
}

// Extracts the number of repositories requested and the cursor from the query text
function queryPageSize(query) {
  return Number(/repositories\(first: (\d+)/.exec(query)[1]);
}
function queryCursor(query) {
  const match = /after: (null|"[^"]*")/.exec(query);
  return match == null || match[1] == "null" ? null : match[1].replaceAll(`"`, "");
}

// Replaces the GraphQL api by a fake that answers the enqueued responses in order and records the
// query text of each call. An enqueued Error makes the request throw, as the api does on request failures.
function createFakeApi() {
  const fake = { queries: [], responses: [] };
  fake.enqueue = function (...responses) { fake.responses.push(...responses); return fake; };
  sinon.stub(gitHubGraphql, "getGraphQlApi").callsFake(function () {
    return async function (query) {
      fake.queries.push(query);
      const response = fake.responses.shift();
      if (response == undefined)
        throw new Error(`Unexpected GraphQL request: page size ${queryPageSize(query)}, cursor ${JSON.stringify(queryCursor(query))}`);
      if (response instanceof Error)
        throw response;
      return response;
    };
  });
  return fake;
}

describe("TestGitHubGraphql - Paginated statuses collection", function () {

  let partialUpdates;
  beforeEach(function () {
    partialUpdates = [];
    sinon.stub(wiController, "updateStatusesForPage").callsFake(function (providerId, model) {
      // A snapshot is stored because the model passed to the ui is not modified by the api
      partialUpdates.push({ providerId: providerId, model: JSON.parse(JSON.stringify(model)) });
    });
  });
  afterEach(function () {
    sinon.restore();
  });

  it("Collects all the pages when every page succeeds", async function () {
    const fake = createFakeApi().enqueue(
      page([repoNode("r1"), repoNode("r2")], true, "cursor1"),
      page([repoNode("r3"), repoNode("r4")], true, "cursor2"),
      page([repoNode("r5")], false, "cursor3"),
    );
    const response = await gitHubGraphql.graphQlWithPagination(provider, 5, 2, "u/xr", true, true, true);
    const pagination = response.pagination;

    // the pages are requested sequentially with the cursor of the previous one
    assert.deepEqual([null, "cursor1", "cursor2"], fake.queries.map(queryCursor));
    // the outcome of every page
    assert.deepEqual(["success", "success", "success"], pagination.pages.map(p => p.outcome));
    assert.deepEqual([2, 2, 1], pagination.pages.map(p => p.count));
    assert.deepEqual([2, 4, 5], pagination.pages.map(p => p.collected));
    assert.deepEqual([true, true, false], pagination.pages.map(p => p.has_next));
    assert.deepEqual(["cursor1", "cursor2", "cursor3"], pagination.pages.map(p => p.cursor));
    assert.deepEqual([null, null, null], pagination.pages.map(p => p.error));
    // the accumulated state
    assert.equal(3, pagination.page);
    assert.equal(4, pagination.next_page);
    assert.equal(5, pagination.collected);
    assert.equal(0, pagination.remaining);
    assert.equal(false, pagination.has_next);
    assert.equal(null, pagination.cursor);
    assert.equal(null, pagination.error);
    // all the nodes are merged in a single response
    assert.deepEqual(["r1", "r2", "r3", "r4", "r5"], response.viewer.repositories.nodes.map(n => n.name));
    // partial updates are only submitted for the intermediate pages
    assert.equal(2, partialUpdates.length);
  });

  it("Keeps the response of the pages collected before a page that returns GraphQL errors", async function () {
    createFakeApi().enqueue(
      page([repoNode("r1"), repoNode("r2")], true, "cursor1"),
      page([repoNode("r3"), repoNode("r4")], true, "cursor2"),
      errorPage(["Something went wrong", "And also this"]),
      page([repoNode("r5")], false, "cursor3"), // must not be requested
    );
    const response = await gitHubGraphql.graphQlWithPagination(provider, 6, 2, "", true, true, true);
    const pagination = response.pagination;

    assert.equal(3, pagination.pages.length); // pagination stops at the failing page
    assert.deepEqual(["success", "success", "error"], pagination.pages.map(p => p.outcome));
    assert.equal("Something went wrong; And also this", pagination.pages[2].error);
    assert.equal("cursor2", pagination.pages[2].after); // the cursor of the failed request
    assert.equal(0, pagination.pages[2].count);
    assert.equal(3, pagination.failed_page);
    assert.equal(3, pagination.next_page); // resuming requests the failed page again
    assert.equal(true, pagination.has_next);
    // the cursor used to resume is the one of the failing page, which has not been collected
    assert.equal("cursor2", pagination.cursor);
    assert.equal(4, pagination.collected);
    assert.equal(2, pagination.remaining);
    // the data collected before the error is not discarded
    assert.equal(4, response.viewer.repositories.nodes.length);
    assert.deepEqual(["r1", "r2", "r3", "r4"], response.viewer.repositories.nodes.map(n => n.name));
    // the model of the collected pages is submitted even if the error interrupts the pagination
    assert.equal(2, partialUpdates.length);
    assert.deepEqual(["owner/r1", "owner/r2", "owner/r3", "owner/r4"], partialUpdates[1].model.header.repo_names);
  });

  it("Keeps the response of the pages collected before a page whose request throws", async function () {
    createFakeApi().enqueue(
      page([repoNode("r1"), repoNode("r2")], true, "cursor1"),
      new Error("network down"),
    );
    const response = await gitHubGraphql.graphQlWithPagination(provider, 4, 2, "", true, true, true);
    const pagination = response.pagination;

    assert.deepEqual(["success", "error"], pagination.pages.map(p => p.outcome));
    assert.equal("network down", pagination.error);
    assert.equal("network down", pagination.pages[1].error);
    assert.equal(2, pagination.failed_page);
    assert.equal(2, pagination.next_page);
    assert.equal(true, pagination.has_next);
    assert.equal("cursor1", pagination.cursor);
    assert.equal(2, pagination.collected);
    assert.equal(2, pagination.remaining);
    assert.equal(2, response.viewer.repositories.nodes.length);
    // the partial model of the first page is submitted to the ui
    assert.equal(1, partialUpdates.length);
    assert.deepEqual(["owner/r1", "owner/r2"], partialUpdates[0].model.header.repo_names);
  });

  it("Keeps the models of the previous pages when the first page fails", async function () {
    createFakeApi().enqueue(errorPage(["bad credentials"]));
    const response = await gitHubGraphql.graphQlWithPagination(provider, 4, 2, "", true, true, true);

    assert.deepEqual(["error"], response.pagination.pages.map(p => p.outcome));
    assert.equal("bad credentials", response.pagination.error);
    assert.equal(1, response.pagination.failed_page);
    assert.equal(null, response.pagination.cursor); // resume from the beginning
    assert.equal(0, response.pagination.collected);
    assert.equal(4, response.pagination.remaining);
    // there is no data nor partial model to submit
    assert.equal(undefined, response.viewer);
    assert.equal(0, partialUpdates.length);
  });

  it("Records an empty page and continues with the next one", async function () {
    createFakeApi().enqueue(
      page([repoNode("r1"), repoNode("r2")], true, "cursor1"),
      page([], true, "cursor2"),
      page([repoNode("r3")], false, "cursor3"),
    );
    const response = await gitHubGraphql.graphQlWithPagination(provider, 5, 2, "", true, false, true);
    const pagination = response.pagination;

    assert.deepEqual(["success", "empty", "success"], pagination.pages.map(p => p.outcome));
    assert.deepEqual([2, 0, 1], pagination.pages.map(p => p.count));
    // the collected counter is not increased by the empty page
    assert.deepEqual([2, 2, 3], pagination.pages.map(p => p.collected));
    assert.deepEqual([true, true, false], pagination.pages.map(p => p.has_next));
    assert.deepEqual(["cursor1", "cursor2", "cursor3"], pagination.pages.map(p => p.cursor));
    assert.equal(3, pagination.collected);
    assert.equal(false, pagination.has_next);
    assert.equal(null, pagination.cursor);
    assert.deepEqual(["r1", "r2", "r3"], response.viewer.repositories.nodes.map(n => n.name));
  });

  it("Resumes the pagination from the cursor and the collected count of an interrupted call", async function () {
    const first = createFakeApi().enqueue(
      page([repoNode("r1"), repoNode("r2")], true, "cursor2"),
      errorPage(["rate limited"]),
    );
    const interrupted = await gitHubGraphql.graphQlWithPagination(provider, 5, 2, "u/xr", true, false, true);
    assert.equal(true, interrupted.pagination.has_next);
    assert.equal("cursor2", interrupted.pagination.cursor);
    assert.equal(2, interrupted.pagination.collected);
    assert.equal(2, interrupted.pagination.next_page); // the failed page
    assert.equal(3, interrupted.pagination.remaining);

    // the second call is made to a different fake api: only the pages not collected before are requested
    sinon.restore();
    sinon.stub(wiController, "updateStatusesForPage");
    const resumed = createFakeApi().enqueue(
      page([repoNode("r3"), repoNode("r4")], true, "cursor4"),
      page([repoNode("r5")], false, "cursor5"),
    );
    const response = await gitHubGraphql.graphQlWithPagination(provider, 5, 2, "u/xr", true, true, true, interrupted.pagination);
    const pagination = response.pagination;

    assert.equal(2, resumed.queries.length);
    // the user specified repos are only attached to the first page of the whole pagination
    assert.ok(first.queries[0].includes("xr0:repository"), "the first page includes the user specified repos");
    assert.ok(!first.queries[1].includes("xr0:repository"), "the second page does not include the user specified repos");
    assert.ok(!resumed.queries[0].includes("xr0:repository"), "the resumed page does not include the user specified repos");
    // it starts from the failed cursor and keeps the requested page size (bounded by the remaining)
    assert.equal("cursor2", queryCursor(resumed.queries[0]));
    assert.equal(2, queryPageSize(resumed.queries[0]));
    assert.equal("cursor4", queryCursor(resumed.queries[1]));
    assert.equal(1, queryPageSize(resumed.queries[1]));

    // the page results and the counters take into account the pages collected before resuming
    assert.deepEqual(["success", "success"], pagination.pages.map(p => p.outcome));
    assert.equal(3, pagination.page); // page numbering continues
    assert.equal(4, pagination.next_page);
    assert.equal(5, pagination.collected);
    assert.equal(0, pagination.remaining);
    assert.equal(false, pagination.has_next);
    assert.equal(null, pagination.cursor);
    assert.equal(null, pagination.error);
    assert.deepEqual([4, 5], pagination.pages.map(p => p.collected));
    assert.deepEqual(["r3", "r4", "r5"], response.viewer.repositories.nodes.map(n => n.name));
  });

  it("Resumes from a bare cursor and collected count", async function () {
    const fake = createFakeApi().enqueue(page([repoNode("r3"), repoNode("r4")], false, "cursor4"));
    // only the two values kept by the caller after an interruption
    const response = await gitHubGraphql.graphQlWithPagination(provider, 4, 2, "", true, false, true,
      { cursor: "cursor2", collected: 2 });
    const pagination = response.pagination;

    // starts from the given cursor, requests only the repositories that were not collected
    assert.equal("cursor2", queryCursor(fake.queries[0]));
    assert.equal(2, queryPageSize(fake.queries[0]));
    assert.deepEqual(["success"], pagination.pages.map(p => p.outcome));
    assert.equal(4, pagination.collected);
    assert.equal(0, pagination.remaining);
    assert.equal(false, pagination.has_next);
    assert.equal(null, pagination.cursor);
    assert.deepEqual(["r3", "r4"], response.viewer.repositories.nodes.map(n => n.name));
  });

  it("Merges the nodes collected before resuming when the previous response is provided", async function () {
    const fake = createFakeApi().enqueue(page([repoNode("r3")], false, "cursor3"));
    const previous = { viewer: { repositories: { nodes: [repoNode("r1"), repoNode("r2")], pageInfo: { hasNextPage: true, endCursor: "cursor2" } } } };
    const response = await gitHubGraphql.graphQlWithPagination(provider, 3, 2, "", true, false, true,
      { cursor: "cursor2", collected: 2, next_page: 2, data: previous });

    assert.equal("cursor2", queryCursor(fake.queries[0]));
    assert.equal(1, queryPageSize(fake.queries[0])); // only the remaining repository
    assert.deepEqual(["r1", "r2", "r3"], response.viewer.repositories.nodes.map(n => n.name));
    assert.equal(3, response.pagination.collected);
    assert.equal(false, response.pagination.has_next);
    assert.equal(2, response.pagination.page);
  });

  it("Bounds the page size to 2..50 and shrinks the last page to the remaining repositories", async function () {
    const fakeLow = createFakeApi().enqueue(
      page([repoNode("r1"), repoNode("r2")], true, "cursor2"),
      page([repoNode("r3")], false, "cursor3"),
    );
    await gitHubGraphql.graphQlWithPagination(provider, 3, 1, "", true, false, true); // below the lower bound
    assert.deepEqual([2, 1], fakeLow.queries.map(queryPageSize));

    sinon.restore();
    const fakeHigh = createFakeApi().enqueue(page([repoNode("r1")], false, "cursor1"));
    await gitHubGraphql.graphQlWithPagination(provider, 100, 51, "", true, false, true); // above the upper bound
    assert.deepEqual([50], fakeHigh.queries.map(queryPageSize));
  });

});

// The caller (GitHubApi) must not discard the pages collected before a failing page: it converts the
// partial response to a model and still returns it to the controller.
describe("TestGitHubGraphql - Partial results delivered to the controller", function () {

  let api;
  let errors;
  let partialUpdates;
  beforeEach(async function () {
    const { gitHubApi } = await import("../app/git/GitHubApi.js");
    const { login } = await import("../app/login/Login.js");
    api = gitHubApi;
    errors = [];
    partialUpdates = [];
    sinon.stub(login, "getProviderToken").returns("token");
    // the ui is not available from node: the partial updates are captured instead of rendered
    sinon.stub(wiController, "updateStatusesForPage").callsFake(function (providerId, model) {
      partialUpdates.push({ providerId: providerId, model: JSON.parse(JSON.stringify(model)) });
    });
    sinon.stub(wiController, "updateStatusesOnError").callsFake(function (message, providerId) {
      errors.push({ message: message, providerId: providerId });
    });
  });
  afterEach(function () {
    sinon.restore();
  });

  it("Returns the model of the collected pages when a page of the full refresh fails", async function () {
    const fake = createFakeApi().enqueue(
      // maxProjects = 2 and pageSize = 2: a single page is enough for the requested scope
      page([repoNode("r1"), repoNode("r2")], true, "cursor1"),
      errorPage(["rate limited"]),
    );
    const fullProvider = { ...provider, graphql: { ...provider.graphql, maxProjects: 4, pageSize: 2, userSpecRepos: "", deprecatedGraphqlV1: false } };
    const model = await api.getStatusesRequest(fullProvider, "");

    assert.equal(2, fake.queries.length);
    // the two repositories of the first page are converted and returned
    assert.deepEqual(["owner/r1", "owner/r2"], model.header.repo_names);
    assert.equal(2, model.items.length);
    // the failure is informed with the page where it happened and the collected/remaining counts
    assert.equal(1, errors.length);
    assert.ok(errors[0].message.includes("page 2"), errors[0].message);
    assert.ok(errors[0].message.includes("Collected 2 repositories, 2 remaining"), errors[0].message);
  });

});
