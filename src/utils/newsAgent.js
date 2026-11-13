
/**
 * NEWS AGENT v1.0
 * Specialized agent for news discovery using free system resources.
 */

const API_BASE = import.meta.env.VITE_BACKEND_URL || '';

class NewsAgent {
    constructor() {
        this.sources = {
            KNOWIVATE: 'Knowivate (Free India News)',
            NEWS_API: 'NewsAPI (Global Headers)',
            AI_SEARCH: 'Liya AI (Web Discovery)',
            REDDIT: 'Reddit Intelligence (Community)',
            RSS: 'Google News (RSS Feed)'
        };
    }

    /**
     * Smart routing to fetch news based on filters
     */
    async fetch({ category = 'general', country = 'us', searchQuery = '' }) {
        console.log(`[NewsAgent] Processing request:`, { category, country, searchQuery });

        // Priority 1: Specific Search -> AI Discovery + Reddit
        if (searchQuery.trim()) {
            const results = await Promise.all([
                this.searchWeb(searchQuery),
                this.fetchReddit(searchQuery)
            ]);
            return [...results[0], ...results[1]].sort(() => Math.random() - 0.5);
        }

        // Priority 2: India Trending -> Knowivate + Google News (IN)
        if (country === 'in') {
            const results = await Promise.all([
                this.fetchKnowivate(),
                this.fetchRSS('in')
            ]);
            return [...results[0], ...results[1]];
        }

        // Priority 3: Global Trending -> RSS + Reddit + NewsAPI (if key)
        const rssResults = await this.fetchRSS(country, category);
        if (rssResults.length > 0) return rssResults;

        const apiKey = import.meta.env.VITE_NEWS_API_KEY;
        if (apiKey) {
            return await this.fetchNewsAPI(country, category, apiKey);
        }

        return await this.searchWeb(`Latest ${category} news in ${country}`);
    }

    /**
     * Skill: Reddit News
     */
    async fetchReddit(query = '') {
        try {
            console.log(`[NewsAgent] Fetching Reddit via Web Search Alternative...`);
            const redditQuery = query ? `${query} site:reddit.com` : 'latest news site:reddit.com/r/news';
            
            const res = await fetch(`${API_BASE}/api/web/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: redditQuery, limit: 5 })
            });
            const data = await res.json();
            const results = data.results || [];

            return results.map(res => ({
                title: res.title,
                description: res.snippet || "View full discussion on Reddit.",
                url: res.url,
                urlToImage: null,
                publishedAt: new Date().toISOString(),
                source: { name: 'Reddit' },
                agentSource: this.sources.REDDIT
            }));
        } catch (e) {
            console.error("[NewsAgent:Reddit] Failed:", e);
            return [];
        }
    }

    /**
     * Skill: Google News RSS
     */
    async fetchRSS(country = 'us', category = 'general') {
        try {
            // Map country codes to Google News HL/GL
            const hl = country === 'in' ? 'hi-IN' : 'en-US';
            const gl = country.toUpperCase();
            
            const res = await fetch(`${API_BASE}/google-news?hl=${hl}&gl=${gl}&ceid=${gl}:${hl}`);
            const text = await res.text();
            
            const parser = new DOMParser();
            const xml = parser.parseFromString(text, "text/xml");
            const items = Array.from(xml.querySelectorAll("item"));

            return items.slice(0, 15).map(item => ({
                title: item.querySelector("title")?.textContent,
                description: "Latest update from Google News RSS.",
                url: item.querySelector("link")?.textContent,
                urlToImage: null,
                publishedAt: item.querySelector("pubDate")?.textContent,
                source: { name: 'Google News' },
                agentSource: this.sources.RSS
            }));
        } catch (e) {
            console.error("[NewsAgent:RSS] Failed:", e);
            return [];
        }
    }

    /**
     * Skill: Knowivate India News
     */
    async fetchKnowivate() {
        try {
            const res = await fetch(`${API_BASE}/knowivate/api/latest?limit=30`);
            const data = await res.json();
            if (Array.isArray(data)) {
                return data.map(article => ({
                    ...article,
                    source: { name: article.source?.name || 'Knowivate' },
                    agentSource: this.sources.KNOWIVATE
                }));
            }
            throw new Error("Invalid Knowivate response");
        } catch (e) {
            console.error("[NewsAgent:Knowivate] Failed:", e);
            return [];
        }
    }

    /**
     * Skill: NewsAPI Proxy
     */
    async fetchNewsAPI(country, category, apiKey) {
        try {
            const url = `${API_BASE}/news/v2/top-headlines?country=${country}&category=${category}&apiKey=${apiKey}`;
            const res = await fetch(url);
            const data = await res.json();
            if (data.status === 'ok' && data.articles) {
                return data.articles.map(article => ({
                    ...article,
                    agentSource: this.sources.NEWS_API
                }));
            }
            throw new Error(data.message || "NewsAPI error");
        } catch (e) {
            console.error("[NewsAgent:NewsAPI] Failed:", e);
            // Fallback to Web Search if NewsAPI fails
            return await this.searchWeb(`Latest ${category} news in ${country}`);
        }
    }

    /**
     * Skill: AI Web Discovery (FREE)
     * Uses backend multi-engine search to find real-time news
     */
    async searchWeb(query) {
        try {
            console.log(`[NewsAgent] Initiating AI Web Discovery for: ${query}`);
            const res = await fetch(`${API_BASE}/api/web/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: `${query} news articles`, limit: 10 })
            });
            const data = await res.json();
            const results = data.results || [];

            return results.map(res => ({
                title: res.title,
                description: res.snippet || "View full article for details.",
                url: res.url,
                urlToImage: null, // Scraper doesn't always provide images in snippets
                publishedAt: new Date().toISOString(),
                source: { name: res.engine || 'Web' },
                agentSource: this.sources.AI_SEARCH
            }));
        } catch (e) {
            console.error("[NewsAgent:AISearch] Failed:", e);
            return [];
        }
    }
}

export const newsAgent = new NewsAgent();
