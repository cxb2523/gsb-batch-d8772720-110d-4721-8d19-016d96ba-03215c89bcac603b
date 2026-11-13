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

/**
 * A document as returned by the XWiki.SuggestSolrService "get" endpoint.
 *
 * Only the fields requested through the "fl" Solr parameter are guaranteed to
 * be present. "links" holds the outgoing links of the document, prefixed with
 * "entity:" (e.g. "entity:document:xwiki:Space.Page").
 */
export interface SolrDocument {
  title_: string;
  reference: string;
  links?: string[];
  wiki?: string;
  spaces?: string[];
  name?: string;
}

/**
 * Statistics of a single BFS expansion layer.
 *
 * Layer 0 always represents the seed (the currently opened document): it
 * contains a single document and does not trigger any Solr query.
 */
export interface LayerStat {
  /** 0-based depth of the layer (0 = seed document). */
  layer: number;
  /** Number of documents discovered during this layer. */
  newDocuments: number;
  /** Number of documents collected in total once this layer is done. */
  totalDocuments: number;
  /** Number of Solr documents returned by the query of this layer. */
  returnedDocuments: number;
  /** Number of documents that were already known before this layer. */
  knownDocuments: number;
  /** Whether the Solr response of this layer was cut by the "nb" limit. */
  truncated: boolean;
  /** Why the expansion did not go past this layer, when applicable. */
  stopReason: "none" | "max-depth" | "no-frontier" | "truncated";
}

/** Node of the link graph, following the conventions expected by graphology. */
export interface GraphNode {
  key: string;
  attributes: {
    label: string;
    color: string;
    size: number;
    pageURL: string;
  };
}

/** Directed edge of the link graph (source references target). */
export interface GraphEdge {
  key: string;
  source: string;
  target: string;
}

export interface LinkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Result of a layered collection. */
export interface LinkGraphResult {
  /** All documents retrieved from Solr, keyed by their reference. */
  documents: Map<string, SolrDocument>;
  /** The reference of the seed document. */
  rootReference: string;
  /** Per-layer statistics, including the synthetic seed layer (index 0). */
  layerStats: LayerStat[];
  /** True as soon as one layer has been truncated by the "nb" limit. */
  truncated: boolean;
  /** The layer (0-based depth) at which the truncation happened, or -1. */
  truncatedAtLayer: number;
  /** The depth limit that was requested. */
  maxDepth: number;
  /** The "nb" (row) limit applied to every Solr query. */
  nb: number;
  /** Number of Solr queries that were actually sent. */
  queryCount: number;
}

/** Options driving a layered collection. */
export interface CollectOptions {
  /** Reference of the seed document, e.g. "document:xwiki:Space.Page". */
  rootReference: string;
  /** Number of expansion layers (1 to 3). Layer 1 = direct & back links. */
  maxDepth: number;
  /** Maximum number of rows returned by each Solr query. */
  nb: number;
  /** Solr endpoint (XWiki.SuggestSolrService "get" URL). */
  solrServiceURL: string;
  /**
   * Function performing the POST request against the Solr endpoint. Injected
   * so that the collection logic stays independent from jQuery and can be
   * unit-tested with a fake Solr service.
   */
  postSolrQuery: (url: string, data: SolrQueryParams) => Promise<SolrDocument[]>;
}

/** Parameters sent to the XWiki.SuggestSolrService "get" endpoint. */
export interface SolrQueryParams {
  outputSyntax: string;
  nb: number;
  media: string;
  query: string;
  input: string;
}

/** Fields requested from Solr; kept identical to the previous implementation. */
export const SOLR_FIELD_LIST = "title_, reference, links, wiki, spaces, name";

/** Minimum / maximum selectable expansion depth in the panel. */
export const MIN_DEPTH = 1;
export const MAX_DEPTH = 3;

/**
 * Escapes the reserved characters of the Solr query syntax (and the
 * whitespace) in the given string. This mirrors the escapeQueryChars
 * function that was previously embedded in the panel JavaScript.
 */
export function escapeQueryChars(s: string): string {
  const specialCharacters = "\\+-!()^[]\"{}~*?|&;:/";
  let escapedString = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (specialCharacters.includes(c) || /\s/.test(c)) {
      escapedString += "\\";
    }
    escapedString += c;
  }
  return escapedString;
}

/**
 * Strips the leading "entity:" prefix of a Solr link value so it can be used
 * as a document reference ("entity:document:xwiki:Foo" -> "document:xwiki:Foo").
 */
export function stripEntityPrefix(link: string): string {
  return link.replace(/^entity:/, "");
}

/**
 * Builds the Solr query string fetching the seed document on its own.
 *
 * The seed has to be retrieved before any expansion because its outgoing
 * links are needed to build the forward-link clauses of the first layer
 * (Solr cannot express "references equal to the links of another document"
 * in a single query).
 */
export function buildSeedQuery(rootReference: string): string {
  return [
    "q=reference:" + escapeQueryChars(rootReference),
    "fq=type:DOCUMENT",
    "fl=" + SOLR_FIELD_LIST
  ].join("\n");
}

/**
 * Builds the multi-line Solr query string of one expansion layer.
 *
 * The query selects every document that:
 *  - is one of the documents of the current frontier (reference match), or
 *  - links back to one of them (back link), or
 *  - is directly referenced by one of them (forward link).
 *
 * Forward links are expanded on the client side: Solr cannot express
 * "references equal to one of the links of another document", so the links
 * of the frontier documents are added explicitly to the query, exactly like
 * the previous single-layer implementation did.
 */
export function buildLayerQuery(
  frontierReferences: string[],
  frontierLinks: string[]
): string {
  const referenceClauses = frontierReferences.map(
    (reference) => "reference:" + escapeQueryChars(reference)
  );
  const backLinkClauses = frontierReferences.map(
    (reference) => "links:entity\\:" + escapeQueryChars(reference)
  );
  const forwardLinkClauses = frontierLinks.map(
    (link) => "reference:" + escapeQueryChars(link)
  );
  const allClauses = referenceClauses.concat(backLinkClauses, forwardLinkClauses);
  return [
    "q=" + allClauses.join(" OR "),
    "fq=type:DOCUMENT",
    "fl=" + SOLR_FIELD_LIST
  ].join("\n");
}

/**
 * Collects the documents reachable from the seed document, layer by layer.
 *
 * The traversal is a breadth-first search: layer N is expanded from the
 * documents discovered at layer N - 1 only. A preliminary query retrieves
 * the seed document itself (layer 0) so that its outgoing links are known
 * before the first expansion. As soon as a Solr response is truncated by
 * the "nb" limit the expansion stops (the missing documents would make any
 * further layer unreliable) and the caller is expected to surface a
 * truncation warning instead of silently drawing an incomplete graph.
 */
export async function collectLinkGraph(options: CollectOptions): Promise<LinkGraphResult> {
  const nb = options.nb;
  const maxDepth = Math.min(Math.max(options.maxDepth, MIN_DEPTH), MAX_DEPTH);
  const documents = new Map<string, SolrDocument>();
  const layerStats: LayerStat[] = [];
  let truncated = false;
  let truncatedAtLayer = -1;
  let queryCount = 0;

  function postQuery(query: string): Promise<SolrDocument[]> {
    queryCount++;
    return options.postSolrQuery(options.solrServiceURL, {
      outputSyntax: "plain",
      nb: nb,
      media: "json",
      query: query,
      input: " "
    });
  }

  // Layer 0: retrieve the seed document on its own, the same way the
  // previous implementation did before fetching its neighborhood.
  const seedResponse = await postQuery(buildSeedQuery(options.rootReference));
  const seedDocument = seedResponse.find(
    (document) => document.reference === options.rootReference
  );
  if (seedDocument) {
    documents.set(seedDocument.reference, seedDocument);
  }
  layerStats.push({
    layer: 0,
    newDocuments: seedDocument ? 1 : 0,
    totalDocuments: documents.size,
    returnedDocuments: seedResponse.length,
    knownDocuments: seedResponse.length - (seedDocument ? 1 : 0),
    // A unique reference cannot return several rows, but keep the guard so
    // a misconfigured "nb" never produces a silently partial seed.
    truncated: seedResponse.length >= nb,
    stopReason: "none"
  });

  // The seed document is missing (deleted, hidden, no view right): there is
  // nothing to expand from, return an empty result.
  if (!seedDocument) {
    return {
      documents: documents,
      rootReference: options.rootReference,
      layerStats: layerStats,
      truncated: truncated,
      truncatedAtLayer: truncatedAtLayer,
      maxDepth: maxDepth,
      nb: nb,
      queryCount: queryCount
    };
  }

  if (seedResponse.length >= nb) {
    truncated = true;
    truncatedAtLayer = 0;
    layerStats[0].truncated = true;
    layerStats[0].stopReason = "truncated";
    return {
      documents: documents,
      rootReference: options.rootReference,
      layerStats: layerStats,
      truncated: truncated,
      truncatedAtLayer: truncatedAtLayer,
      maxDepth: maxDepth,
      nb: nb,
      queryCount: queryCount
    };
  }

  // BFS expansion: layer 1 starts from the seed alone.
  let frontier: string[] = [options.rootReference];

  for (let depth = 1; depth <= maxDepth; depth++) {
    // Forward links can only be listed for frontier documents we already hold.
    const frontierLinks: string[] = [];
    frontier.forEach((reference) => {
      const document = documents.get(reference);
      if (document && document.links) {
        document.links.forEach((link) => frontierLinks.push(stripEntityPrefix(link)));
      }
    });

    const response = await postQuery(buildLayerQuery(frontier, frontierLinks));

    // Solr never returns more rows than the requested "nb": reaching this
    // number means the result set has been cut and some matching documents
    // are missing.
    const layerTruncated = response.length >= nb;
    let newDocuments = 0;
    const layerNewReferences: string[] = [];
    response.forEach((document) => {
      if (!documents.has(document.reference)) {
        documents.set(document.reference, document);
        newDocuments++;
        layerNewReferences.push(document.reference);
      }
    });

    if (layerTruncated) {
      truncated = true;
      truncatedAtLayer = depth;
      layerStats.push({
        layer: depth,
        newDocuments: newDocuments,
        totalDocuments: documents.size,
        returnedDocuments: response.length,
        knownDocuments: response.length - newDocuments,
        truncated: true,
        stopReason: "truncated"
      });
      // The frontier cannot be trusted anymore: stop expanding.
      break;
    }

    // Next frontier = documents discovered by this layer only.
    let stopReason: LayerStat["stopReason"] = "none";
    if (layerNewReferences.length === 0) {
      stopReason = "no-frontier";
    } else if (depth === maxDepth) {
      stopReason = "max-depth";
    }

    layerStats.push({
      layer: depth,
      newDocuments: newDocuments,
      totalDocuments: documents.size,
      returnedDocuments: response.length,
      knownDocuments: response.length - newDocuments,
      truncated: false,
      stopReason: stopReason
    });

    if (layerNewReferences.length === 0) {
      break;
    }
    frontier = layerNewReferences;
  }

  return {
    documents: documents,
    rootReference: options.rootReference,
    layerStats: layerStats,
    truncated: truncated,
    truncatedAtLayer: truncatedAtLayer,
    maxDepth: maxDepth,
    nb: nb,
    queryCount: queryCount
  };
}

/**
 * Builds the graphology-compatible nodes and edges from a collected result.
 *
 * Conventions inherited from the previous implementation:
 *  - node keys are document references;
 *  - an edge is created only when its target is present in the result set,
 *    so the graph never references a dangling node;
 *  - the seed document keeps a distinct (orange, larger) highlight.
 */
export function buildGraph(
  result: LinkGraphResult,
  themeColors: { nodeColor: string },
  resolvePageURL: (reference: string) => string,
  rootColor: string = "orange",
  rootSize: number = 12,
  nodeSize: number = 8
): LinkGraph {
  const nodes: GraphNode[] = [];
  result.documents.forEach((document) => {
    const isRoot = document.reference === result.rootReference;
    nodes.push({
      key: document.reference,
      attributes: {
        label: document.title_,
        color: isRoot ? rootColor : themeColors.nodeColor,
        size: isRoot ? rootSize : nodeSize,
        pageURL: resolvePageURL(document.reference)
      }
    });
  });

  const edges: GraphEdge[] = [];
  let edgeKeyCounter = 1;
  result.documents.forEach((document) => {
    if (document.links && document.links.length > 0) {
      document.links.forEach((link) => {
        const target = stripEntityPrefix(link);
        if (result.documents.has(target)) {
          edges.push({
            key: edgeKeyCounter.toString(),
            source: document.reference,
            target: target
          });
          edgeKeyCounter++;
        }
      });
    }
  });

  return { nodes: nodes, edges: edges };
}

/**
 * Thrown by LatestRequestRunner when a job finishes after a newer job has
 * been started. The panel catches this error and ignores the stale result so
 * that a slow response can never overwrite a more recent graph.
 */
export class StaleRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleRequestError";
    Object.setPrototypeOf(this, StaleRequestError.prototype);
  }
}

/**
 * Runs asynchronous collection jobs while keeping only the latest one.
 *
 * Every call to run() invalidates the previous job: if an older job settles
 * afterwards, its promise rejects with StaleRequestError instead of
 * resolving, which makes "the old response must not overwrite the new
 * result" impossible to get wrong at the call site.
 */
export class LatestRequestRunner<T> {
  private currentToken = 0;

  /**
   * Starts a new job and returns its result. The returned promise rejects
   * with StaleRequestError if another job has been started in the meantime.
   */
  public run(job: () => Promise<T>): Promise<T> {
    this.currentToken++;
    const token = this.currentToken;
    return job().then(
      (value) => {
        if (token !== this.currentToken) {
          return Promise.reject(new StaleRequestError("A newer collection request superseded this one"));
        }
        return value;
      },
      (reason) => {
        if (token !== this.currentToken) {
          return Promise.reject(new StaleRequestError("A newer collection request superseded this one"));
        }
        return Promise.reject(reason);
      }
    );
  }

  /** Number of jobs started so far (also the token of the latest job). */
  public get startedCount(): number {
    return this.currentToken;
  }
}
