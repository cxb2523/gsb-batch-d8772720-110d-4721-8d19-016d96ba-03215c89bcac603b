import { config } from './config';

export const fetchNews = async (category = 'general') => {
    // CACHE CHECK: Prevent API rate-limiting (15-min TTL)
    const CACHE_KEY = `LIYA_NEWS_CACHE_${category}`;
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
        const { timestamp, content } = JSON.parse(cached);
        if (Date.now() - timestamp < 15 * 60 * 1000) {
            console.log(`[Cache] Returning cached news for: ${category}`);
            return content;
        }
    }

    // Timeout Promise to prevent Chat Hang
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s limit

    try {
        let articles = [];
        let isKnowivate = false;
        let url = '';

        // If category is explicitly 'india', use Knowivate (Free)
        if (category === 'india') {
            url = `/knowivate/api/latest?limit=10`;
            isKnowivate = true;
        } else {
            // Default to US for other categories
            // Note: API Key check is needed here
            const API_KEY = config.getApiKey('VITE_NEWS_API_KEY');
            if (!API_KEY) {
                clearTimeout(timeoutId);
                return null;
            }
            const baseUrl = import.meta.env.VITE_BACKEND_URL || '';
            url = `${baseUrl}/news/v2/top-headlines?country=us&category=${category}&apiKey=${API_KEY}`;
        }

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error("News API Failed:", response.status);
            return null;
        }

        const data = await response.json();

        if (Array.isArray(data)) {
            // Knowivate returns array directly
            articles = data;
        } else if (data.articles) {
            // NewsAPI returns object with articles array
            articles = data.articles;
        }

        if (articles.length > 0) {
            // Format 5 top stories
            const stories = articles.slice(0, 5).map((article, index) => {
                const source = article.source?.name || 'Unknown';
                return `${index + 1}. ${article.title} (Source: ${source})`;
            }).join('\n');

            const resultString = `[Latest News Headlines (${isKnowivate ? 'India' : 'US/Global'}): \n${stories}\n]`;

            // SAVE TO CACHE
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                timestamp: Date.now(),
                content: resultString
            }));

            return resultString;
        }

        return "[No news found]";

    } catch (e) {
        clearTimeout(timeoutId);
        console.error("News Fetch Error:", e.name === 'AbortError' ? 'Timeout' : e);
        return null;
    }
};
