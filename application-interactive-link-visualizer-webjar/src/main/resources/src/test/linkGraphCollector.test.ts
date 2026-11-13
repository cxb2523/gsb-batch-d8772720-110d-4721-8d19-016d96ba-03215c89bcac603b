/*
 * See the NOTICE file distributed with this work for additional
 * information regarding copyright ownership.
 *
 * This is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as
 * published by the Free Software Foundation; either version 2.1 of
 * the License, or (at your option) any later version.
 *
 * This software is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this software; if not, write to the Free
 * Software Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
 * 02110-1301 USA, or see the FSF site: http://www.fsf.org.
 */

/*
 * Local, dependency-free verification of the layered collection logic.
 *
 * Run with:
 *   npm run test-local
 * which compiles this directory with tsconfig.test.json and executes the
 * output with Node. No XWiki or Solr instance is required: the Solr endpoint
 * is replaced by the fakes in fakeSolrService.ts and the canned responses
 * under solr-samples/.
 */

import {
  buildGraph,
  buildLayerQuery,
  buildSeedQuery,
  collectLinkGraph,
  escapeQueryChars,
  LatestRequestRunner,
  LinkGraphResult,
  MAX_DEPTH,
  MIN_DEPTH,
  SolrDocument,
  StaleRequestError
} from "../linkGraphCollector";
import { FakeSolrService, ScriptedSolrService } from "./fakeSolrService";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

function resolveSampleDir(): string {
  // When run from the compiled output (target/test-local/test), the samples
  // stay in the source tree. A co-located copy is also supported.
  const candidates = [
    join(__dirname, "solr-samples"),
    join(__dirname, "..", "..", "..", "src", "main", "resources", "src", "test", "solr-samples")
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error("Cannot locate the solr-samples directory");
  }
  return match;
}

const SAMPLE_DIR = resolveSampleDir();

function loadSample(relativePath: string): SolrDocument[] {
  return JSON.parse(readFileSync(join(SAMPLE_DIR, relativePath), "utf8"));
}

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, details?: string): void {
  checks++;
  if (condition) {
    console.log("  ok - " + label);
  } else {
    failures++;
    console.error("  FAIL - " + label + (details ? " (" + details + ")" : ""));
  }
}

function checkEquals(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    actual === expected,
    "expected " + JSON.stringify(expected) + " but got " + JSON.stringify(actual)
  );
}

const ROOT = "document:xwiki:Main.Root";
const SOLR_URL = "http://localhost/xwiki/bin/get/XWiki/SuggestSolrService";

function fullCorpus(): SolrDocument[] {
  // The complete wiki modeled by the layered samples.
  return [
    {
      title_: "Root Page",
      reference: ROOT,
      links: [
        "entity:document:xwiki:Main.D1",
        "entity:document:xwiki:Main.D2",
        "entity:document:xwiki:Main.D4"
      ],
      wiki: "xwiki",
      spaces: ["Main"],
      name: "Root"
    },
    {
      title_: "Direct Page One",
      reference: "document:xwiki:Main.D1",
      links: ["entity:document:xwiki:Main.D2"]
    },
    {
      title_: "Direct Page Two",
      reference: "document:xwiki:Main.D2",
      links: ["entity:document:xwiki:Main.D3"]
    },
    {
      title_: "Indirect Page Three",
      reference: "document:xwiki:Main.D3",
      links: []
    },
    {
      title_: "Direct Page Four",
      reference: "document:xwiki:Main.D4",
      links: []
    }
  ];
}

async function testEscapeQueryChars(): Promise<void> {
  console.log("escapeQueryChars");
  checkEquals(
    "escapes reserved characters and whitespace",
    escapeQueryChars("a:b c+d"),
    "a\\:b\\ c\\+d"
  );
  checkEquals("leaves plain text untouched", escapeQueryChars("Main.Root"), "Main.Root");
}

async function testBuildLayerQuery(): Promise<void> {
  console.log("buildLayerQuery / buildSeedQuery");
  const query = buildLayerQuery(
    ["document:xwiki:Main.Root"],
    ["document:xwiki:Main.D1"]
  );
  check("contains the reference clause of the frontier", query.indexOf("reference:document\\:xwiki\\:Main.Root") !== -1);
  check("contains the back link clause", query.indexOf("links:entity\\:document\\:xwiki\\:Main.Root") !== -1);
  check("contains the forward link clause", query.indexOf("reference:document\\:xwiki\\:Main.D1") !== -1);
  check("keeps the DOCUMENT filter", query.indexOf("fq=type:DOCUMENT") !== -1);
  check(
    "keeps the required fl fields",
    query.indexOf("fl=title_, reference, links, wiki, spaces, name") !== -1
  );
  const seedQuery = buildSeedQuery(ROOT);
  check("seed query targets the root reference", seedQuery.indexOf("q=reference:document\\:xwiki\\:Main.Root") !== -1);
}

async function testDepthOneWithScriptedSamples(): Promise<void> {
  console.log("depth 1 against canned seed + layer-1 samples");
  const seed = loadSample(join("layered", "seed.json"));
  const layer1 = loadSample(join("layered", "layer-1.json"));
  const fake = new ScriptedSolrService([seed, layer1]);
  const result = await collectLinkGraph({
    rootReference: ROOT,
    maxDepth: 1,
    nb: 1000,
    solrServiceURL: SOLR_URL,
    postSolrQuery: fake.post
  });
  checkEquals("sends the seed query then one expansion query", fake.callLog.length, 2);
  checkEquals("nb is forwarded to Solr", fake.callLog[1].nb, 1000);
  checkEquals("media is json", fake.callLog[1].media, "json");
  checkEquals("input stays a blank string", fake.callLog[1].input, " ");
  checkEquals("collects the 4 documents of the sample", result.documents.size, 4);
  check("not truncated", result.truncated === false);
  checkEquals("seed layer + one expansion layer", result.layerStats.length, 2);
  checkEquals("seed stat new documents", result.layerStats[0].newDocuments, 1);
  checkEquals("layer 1 new documents", result.layerStats[1].newDocuments, 3);
  checkEquals("layer 1 cumulative documents", result.layerStats[1].totalDocuments, 4);
  checkEquals("layer 1 stop reason", result.layerStats[1].stopReason, "max-depth");
}

async function testDepthThreeBfsWithCorpusFake(): Promise<void> {
  console.log("depth 3 BFS expansion against in-memory Solr fake");
  const fake = new FakeSolrService(fullCorpus());
  const result = await collectLinkGraph({
    rootReference: ROOT,
    maxDepth: 3,
    nb: 1000,
    solrServiceURL: SOLR_URL,
    postSolrQuery: fake.post
  });

  // Bootstrap: Root alone. Layer 1: Root + D1 + D2 + D4. Layer 2: D3 appears.
  // Layer 3: no new document, the traversal stops early.
  checkEquals("collects every reachable document", result.documents.size, 5);
  checkEquals("bootstrap + 3 expansion queries", fake.callLog.length, 4);
  checkEquals("seed layer + three expansion layers", result.layerStats.length, 4);

  const l0 = result.layerStats[0];
  const l1 = result.layerStats[1];
  const l2 = result.layerStats[2];
  const l3 = result.layerStats[3];
  checkEquals("seed layer discovers the root", l0.newDocuments, 1);
  checkEquals("layer 1 discovers 3 new documents", l1.newDocuments, 3);
  checkEquals("layer 1 cumulative is 4", l1.totalDocuments, 4);
  checkEquals("layer 2 discovers D3 only", l2.newDocuments, 1);
  checkEquals("layer 2 cumulative is 5", l2.totalDocuments, 5);
  checkEquals("layer 3 discovers nothing", l3.newDocuments, 0);
  checkEquals("layer 3 stops on empty frontier", l3.stopReason, "no-frontier");
  check("no layer is truncated", result.layerStats.every((stat) => !stat.truncated));

  // Each query must only expand the previous frontier.
  const layer2Query = fake.callLog[2].query;
  check(
    "layer 2 expands the depth-1 frontier",
    layer2Query.indexOf("reference:document\\:xwiki\\:Main.D1") !== -1 &&
      layer2Query.indexOf("reference:document\\:xwiki\\:Main.D4") !== -1
  );
}

async function testDepthClamping(): Promise<void> {
  console.log("depth limits are clamped to the supported range");
  const fake = new FakeSolrService(fullCorpus());
  const result = await collectLinkGraph({
    rootReference: ROOT,
    maxDepth: 99,
    nb: 1000,
    solrServiceURL: SOLR_URL,
    postSolrQuery: fake.post
  });
  checkEquals("maxDepth clamped to MAX_DEPTH", result.maxDepth, MAX_DEPTH);
  check("MIN_DEPTH is 1", MIN_DEPTH === 1);
}

async function testTruncationStopsExpansion(): Promise<void> {
  console.log("truncated response stops the expansion and is flagged");
  const seed = loadSample(join("truncated", "seed.json"));
  const truncatedLayer1 = loadSample(join("truncated", "layer-1.json"));
  const fake = new ScriptedSolrService([seed, truncatedLayer1]);
  const result = await collectLinkGraph({
    rootReference: "document:xwiki:Main.Truncated",
    maxDepth: 3,
    nb: 3,
    solrServiceURL: SOLR_URL,
    postSolrQuery: fake.post
  });
  checkEquals("no expansion query follows the truncated one", fake.callLog.length, 2);
  check("result is flagged truncated", result.truncated);
  checkEquals("truncation reported at layer 1", result.truncatedAtLayer, 1);
  // The truncated layer returns 3 rows; two were already known through the
  // seed (Truncated itself), so only one new document is actually added.
  checkEquals("keeps the seed plus the new documents returned so far", result.documents.size, 3);
  checkEquals("truncated stat stop reason", result.layerStats[1].stopReason, "truncated");
  checkEquals("truncated stat flag", result.layerStats[1].truncated, true);
}

async function testCorpusFakeTruncation(): Promise<void> {
  console.log("nb cap of the in-memory fake reproduces Solr truncation");
  const fake = new FakeSolrService(fullCorpus());
  const result = await collectLinkGraph({
    rootReference: ROOT,
    maxDepth: 3,
    nb: 2,
    solrServiceURL: SOLR_URL,
    postSolrQuery: fake.post
  });
  check("truncation detected via nb boundary", result.truncated);
  checkEquals("expansion stops at the first layer", result.queryCount, 2);
  // The bootstrap keeps the root; the truncated layer keeps 2 rows (one of
  // which may be the already known root), for 3 documents at most.
  check("no more documents than the rows actually returned", result.documents.size <= 3);
  checkEquals("the truncated layer returned exactly nb rows", result.layerStats[1].returnedDocuments, 2);
}

async function testMissingSeedDocument(): Promise<void> {
  console.log("missing seed document yields an empty graph without expanding");
  const fake = new ScriptedSolrService([[]]);
  const result = await collectLinkGraph({
    rootReference: "document:xwiki:Main.Ghost",
    maxDepth: 3,
    nb: 1000,
    solrServiceURL: SOLR_URL,
    postSolrQuery: fake.post
  });
  checkEquals("only the seed query is sent", fake.callLog.length, 1);
  checkEquals("no document collected", result.documents.size, 0);
  check("not marked as truncated", result.truncated === false);
  checkEquals("only the seed stat is reported", result.layerStats.length, 1);
}

async function testBackLinksAreCollected(): Promise<void> {
  console.log("documents linking back to the seed are collected");
  const corpus: SolrDocument[] = [
    { title_: "Root", reference: ROOT, links: [] },
    { title_: "Back Linker", reference: "document:xwiki:Main.Back", links: ["entity:" + ROOT] }
  ];
  const fake = new FakeSolrService(corpus);
  const result = await collectLinkGraph({
    rootReference: ROOT,
    maxDepth: 1,
    nb: 1000,
    solrServiceURL: SOLR_URL,
    postSolrQuery: fake.post
  });
  check("back linker collected", result.documents.has("document:xwiki:Main.Back"));
}

async function testGraphBuilding(): Promise<void> {
  console.log("node and edge construction");
  const fake = new FakeSolrService(fullCorpus());
  const result: LinkGraphResult = await collectLinkGraph({
    rootReference: ROOT,
    maxDepth: 2,
    nb: 1000,
    solrServiceURL: SOLR_URL,
    postSolrQuery: fake.post
  });
  const graph = buildGraph(
    result,
    { nodeColor: "#3366cc" },
    (reference) => "http://localhost/view/" + reference
  );

  checkEquals("one node per collected document", graph.nodes.length, 5);
  const rootNode = graph.nodes.find((node) => node.key === ROOT);
  check("root node is orange", rootNode !== undefined && rootNode.attributes.color === "orange");
  check("root node is larger", rootNode !== undefined && rootNode.attributes.size === 12);
  const otherNode = graph.nodes.find((node) => node.key !== ROOT);
  check("other nodes use the theme color", otherNode !== undefined && otherNode.attributes.color === "#3366cc");
  check("other nodes keep the regular size", otherNode !== undefined && otherNode.attributes.size === 8);
  check("pageURL is resolved through the injected helper", rootNode !== undefined && rootNode.attributes.pageURL.indexOf(ROOT) !== -1);

  const edgePairs = graph.edges.map((edge) => edge.source + "->" + edge.target);
  check("Root -> D1 edge present", edgePairs.indexOf(ROOT + "->document:xwiki:Main.D1") !== -1);
  check("D1 -> D2 edge present", edgePairs.indexOf("document:xwiki:Main.D1->document:xwiki:Main.D2") !== -1);
  check("D2 -> D3 edge present", edgePairs.indexOf("document:xwiki:Main.D2->document:xwiki:Main.D3") !== -1);
  check(
    "no edge targets a missing document",
    graph.edges.every(
      (edge) => result.documents.has(edge.source) && result.documents.has(edge.target)
    )
  );
  check(
    "edge keys are unique",
    new Set(graph.edges.map((edge) => edge.key)).size === graph.edges.length
  );
}

async function testDanglingLinksAreIgnored(): Promise<void> {
  console.log("links to documents absent from the result set create no edge");
  const corpus: SolrDocument[] = [
    {
      title_: "Root",
      reference: ROOT,
      links: ["entity:document:xwiki:Main.Missing"]
    }
  ];
  const fake = new FakeSolrService(corpus);
  const result = await collectLinkGraph({
    rootReference: ROOT,
    maxDepth: 1,
    nb: 1000,
    solrServiceURL: SOLR_URL,
    postSolrQuery: fake.post
  });
  const graph = buildGraph(
    result,
    { nodeColor: "#3366cc" },
    (reference) => "http://localhost/view/" + reference
  );
  checkEquals("single isolated node", graph.nodes.length, 1);
  checkEquals("no edge for the dangling link", graph.edges.length, 0);
}

async function testLatestRequestRunner(): Promise<void> {
  console.log("LatestRequestRunner drops responses of superseded requests");
  const runner = new LatestRequestRunner<string>();

  // Manual deferred controls to interleave completion order.
  let resolveOld: (value: string) => void = () => {};
  let resolveNew: (value: string) => void = () => {};
  const oldJob = new Promise<string>((resolve) => (resolveOld = resolve));
  const newJob = new Promise<string>((resolve) => (resolveNew = resolve));

  const oldPromise = runner.run(() => oldJob);
  checkEquals("one job started", runner.startedCount, 1);
  const newPromise = runner.run(() => newJob);
  checkEquals("two jobs started", runner.startedCount, 2);

  // The old request resolves first (slow network on the previous depth):
  // it must surface as a stale rejection, not as a usable result.
  resolveOld("old-result");
  let oldRejected = false;
  try {
    await oldPromise;
  } catch (error) {
    oldRejected = error instanceof StaleRequestError;
  }
  check("superseded request rejects with StaleRequestError", oldRejected);

  resolveNew("new-result");
  checkEquals("latest request still resolves normally", await newPromise, "new-result");

  // A single, non-superseded job resolves directly.
  checkEquals("sole job resolves with its value", await runner.run(() => Promise.resolve("solo")), "solo");
}

async function main(): Promise<void> {
  const suites = [
    testEscapeQueryChars,
    testBuildLayerQuery,
    testDepthOneWithScriptedSamples,
    testDepthThreeBfsWithCorpusFake,
    testDepthClamping,
    testTruncationStopsExpansion,
    testCorpusFakeTruncation,
    testMissingSeedDocument,
    testBackLinksAreCollected,
    testGraphBuilding,
    testDanglingLinksAreIgnored,
    testLatestRequestRunner
  ];
  for (const suite of suites) {
    await suite();
  }
  console.log("\n" + checks + " checks, " + failures + " failures");
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main();
