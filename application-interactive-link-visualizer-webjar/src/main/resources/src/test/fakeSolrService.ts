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

import { SolrDocument, SolrQueryParams } from "../linkGraphCollector";

/**
 * Minimal in-memory fake of the XWiki.SuggestSolrService "get" endpoint.
 *
 * It answers Solr queries built by linkGraphCollector (OR-combinations of
 * "reference:" and "links:entity:" clauses) against a fixed corpus, and
 * applies the same "nb" row cap as Solr, which is what lets the tests
 * exercise the truncation branch deterministically.
 */
export class FakeSolrService {
  private corpus: Map<string, SolrDocument>;
  public callLog: SolrQueryParams[] = [];

  constructor(documents: SolrDocument[]) {
    this.corpus = new Map<string, SolrDocument>();
    documents.forEach((document) => this.corpus.set(document.reference, document));
  }

  /**
   * Handler matching the postSolrQuery signature injected into the collector.
   */
  public post = (url: string, params: SolrQueryParams): Promise<SolrDocument[]> => {
    this.callLog.push(params);
    const queryLine = params.query.split("\n").find((line) => line.indexOf("q=") === 0);
    const wantedReferences = new Set<string>();
    if (queryLine) {
      const clauses = queryLine.substring(2).split(" OR ");
      clauses.forEach((clause) => {
        if (clause.indexOf("reference:") === 0) {
          wantedReferences.add(this.unescape(clause.substring("reference:".length)));
        } else if (clause.indexOf("links:entity:") === 0 || clause.indexOf("links:entity\\:") === 0) {
          const wanted = this.unescape(
            clause.substring("links:".length).replace(/^entity\\?:/, "")
          );
          // Back link: every corpus document linking to the wanted reference.
          this.corpus.forEach((document) => {
            if (
              document.links &&
              document.links.some((link) => link.replace(/^entity:/, "") === wanted)
            ) {
              wantedReferences.add(document.reference);
            }
          });
        }
      });
    }

    const matches: SolrDocument[] = [];
    wantedReferences.forEach((reference) => {
      const document = this.corpus.get(reference);
      if (document) {
        matches.push(document);
      }
    });
    // Stable ordering so truncation cuts the same documents on every run.
    matches.sort((a, b) => (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0));
    return Promise.resolve(matches.slice(0, params.nb));
  };

  private unescape(value: string): string {
    return value.replace(/\\(.)/g, "$1");
  }
}

/**
 * Scripted fake that replays canned Solr responses (the JSON files under
 * solr-samples), one response per call. Used to validate the collector
 * against hand-written responses including exact "nb boundary" truncation
 * cases that would be cumbersome to reproduce with the corpus-based fake.
 */
export class ScriptedSolrService {
  private responses: SolrDocument[][];
  public callLog: SolrQueryParams[] = [];

  constructor(responses: SolrDocument[][]) {
    this.responses = responses;
  }

  public post = (url: string, params: SolrQueryParams): Promise<SolrDocument[]> => {
    this.callLog.push(params);
    const index = this.callLog.length - 1;
    if (index >= this.responses.length) {
      return Promise.reject(new Error("Unexpected extra Solr query in scripted fake"));
    }
    return Promise.resolve(this.responses[index]);
  };
}
