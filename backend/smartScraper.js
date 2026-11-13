/**
 * Smart Scraper Engine for Liya
 * Converts raw web pages into clean, LLM-friendly Markdown.
 * Features:
 *   1. Readability + Turndown — Strips ads, navbars, footers. Returns pure Markdown.
 *   2. Stealth Mode — Rotating User-Agents to avoid bot detection.
 *   3. Jina.ai Fallback — If Playwright fails, use free r.jina.ai reader API.
 *   4. Deep Research — Crawl top N links from a search and merge into one report.
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const TurndownService = require('turndown');
const axios = require('axios');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const {
    ENGINES,
    runScrapePipeline,
    validateCrawl4AIPayload,
    mergeDeepResearchResults,
} = require('./scrapeOrchestrator');

// --- STEALTH: Rotating User-Agents ---
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:126.0) Gecko/20100101 Firefox/126.0',
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// --- Turndown instance (HTML -> Markdown converter) ---
const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
});

// Remove scripts, styles, images (optional: keep images if needed)
turndown.remove(['script', 'style', 'nav', 'footer', 'aside', 'iframe', 'noscript']);

// --- CORE: Smart Browse (Playwright + Readability + Turndown) ---
// Canvas Summarizer Helper
async function summarizeAndPushToCanvas(title, rawMarkdown, isFallback = false, screenshotPath = '', modelOverride = null) {
    const { pushToCanvas } = require('./canvasBridge');
    const id = isFallback ? `browse_fallback_${Date.now()}` : `browse_${Date.now()}`;
    const label = isFallback ? 'SMART BROWSER (FALLBACK)' : 'SMART BROWSER';

    const renderWithScreenshot = (text) => {
        if (!screenshotPath) return text;
        return `![Screenshot of ${title}](${screenshotPath})\n\n---\n\n${text}`;
    };

    // Push "Generating Summary..." immediately
    try {
        pushToCanvas({
            id,
            type: 'markdown',
            label,
            title,
            content: renderWithScreenshot('*Generating intelligent summary of the webpage...*\n\n---\n\n' + rawMarkdown.substring(0, 300) + '...')
        });
    } catch (e) {}

    // Run LLM Summary
    try {
        const { Ollama } = require('ollama');
        const { getBackendApiKey, getBackendModel } = require('./configHelper');
        const apiKey = getBackendApiKey('VITE_OLLAMA_CLOUD_API_KEY');
        const model = modelOverride || getBackendModel('OLLAMA_SMART_MODEL', 'gemma4:31b-cloud');
        
        if (!apiKey) throw new Error("No API key for summarizer");

        const ollama = new Ollama({ host: 'https://api.ollama.com', headers: { 'Authorization': `Bearer ${apiKey}` } });
        
        const prompt = `Summarize the following scraped website content. 
Extract the MAIN DETAILS (Company Name, Location, Products/Services, Contact Info). Keep it short, concise, and well-formatted with markdown lists.
Do NOT output the raw text.

Website Title: ${title}
Content:
${rawMarkdown.substring(0, 6000)}`;

        const response = await ollama.chat({ model: model, messages: [{ role: 'user', content: prompt }], stream: false });
        let summary = response.message.content.trim();

        // Push final summary
        pushToCanvas({
            id,
            type: 'markdown',
            label: label + ' [SUMMARIZED]',
            title,
            content: renderWithScreenshot(summary)
        });
    } catch (e) {
        console.warn("[SmartScraper] Summarizer failed, keeping raw text.", e.message);
        // Fallback to raw if summarizer fails
        try {
            pushToCanvas({
                id,
                type: 'markdown',
                label,
                title,
                content: renderWithScreenshot(rawMarkdown)
            });
        } catch (err) {}
    }
}

// --- Crawl4AI Engine (Primary High-Speed LLM Crawler) ---
async function crawlWithCrawl4AI(url, options = {}) {
    const { maxChars = 15000 } = options;
    return new Promise((resolve, reject) => {
        const pythonPath = 'python';
        const scriptPath = path.join(__dirname, 'crawl4ai_runner.py');
        const child = spawn(pythonPath, [scriptPath, url, String(maxChars)], {
            timeout: 25000,
            windowsHide: true,
            env: { ...process.env, CRAWL4AI_NO_CLOUD_NOTICE: '1' }
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', data => {
            stdout += data.toString();
        });
        child.stderr.on('data', data => {
            stderr += data.toString();
        });

        child.on('close', code => {
            if (code !== 0) {
                return reject(new Error(`Crawl4AI exited with code ${code}: ${stderr || stdout}`));
            }
            try {
                const match = stdout.match(/__CRAWL4AI_JSON_START__([\s\S]*?)__CRAWL4AI_JSON_END__/);
                if (!match) {
                    return reject(new Error('Crawl4AI delimiter not found in runner output'));
                }
                const parsed = JSON.parse(match[1]);
                if (!parsed.success) {
                    return reject(new Error(parsed.error || 'Crawl4AI reported failure'));
                }
                resolve(parsed);
            } catch (err) {
                reject(err);
            }
        });

        child.on('error', err => {
            reject(err);
        });
    });
}

/**
 * Run the tiered scraping pipeline with per-tier attempt recording.
 *
 * The three engines are the existing Crawl4AI / Playwright / Jina
 * implementations, wrapped as injectable descriptors so the orchestration
 * (degradation order, short-content rule, attempts bookkeeping) lives in
 * the dependency-free scrapeOrchestrator module and can be unit-tested
 * without a browser or network.
 *
 * @param {string} url
 * @param {object} options Normalized smartBrowse options.
 * @param {object} [overrides] Optional injected engine runners
 *   ({ crawl4ai, playwright, jina }) used by tests.
 * @returns {Promise<object>} Result payload including an `attempts` array.
 */
async function runSmartBrowsePipeline(url, options, overrides = {}) {
    const {
        action = 'markdown',
        maxChars = 15000,
        takeScreenshot = false,
        viewportType = 'desktop',
        pushToCanvas = false,
    } = options;

    const runCrawl4AI = overrides.crawl4ai || crawlWithCrawl4AI;
    const runPlaywrightEngine = overrides.playwright || (() => playwrightBrowse(url, options));
    const runJinaEngine = overrides.jina || (() => jinaFetch(url, maxChars));

    // Build the engine list in actual attempt order. Crawl4AI is only a
    // candidate for markdown/text requests without a screenshot request.
    const engines = [];
    if ((action === 'markdown' || action === 'text') && !takeScreenshot) {
        engines.push({
            name: ENGINES.CRAWL4AI,
            run: () => runCrawl4AI(url, options),
        });
    }
    engines.push({ name: ENGINES.PLAYWRIGHT, run: runPlaywrightEngine });
    engines.push({ name: ENGINES.JINA, run: runJinaEngine });

    // Only Tier 1 enforces the short-content rule; Playwright and Jina
    // results are accepted exactly as before.
    const validate = (engineName, payload) => {
        if (engineName === ENGINES.CRAWL4AI) {
            return validateCrawl4AIPayload(payload);
        }
        return payload;
    };

    const result = await runScrapePipeline(engines, { url, validate });

    // All engines failed: nothing to push, return the legacy failure shape
    // (its markdown wording is unchanged) with the full attempts trail.
    if (result.method === 'all-failed') {
        return result;
    }

    // Preserve the previous text-action behaviour of Crawl4AI, whose
    // runner only returns markdown. Playwright already sets text itself.
    if (action === 'text' && result.method === 'crawl4ai') {
        result.text = result.markdown;
    }

    // Canvas summarization. The previous implementation pushed from inside
    // each engine; here the same calls fire once after the winning engine is
    // known, with identical arguments and fallback flagging.
    //   - Crawl4AI pushed on every action when requested.
    //   - Playwright pushed only for markdown actions.
    //   - Jina pushed whenever requested (flagged as a fallback).
    if (pushToCanvas && !options.silent) {
        if (result.method === 'jina-fallback') {
            summarizeAndPushToCanvas(result.title, result.markdown, true, '', options.model);
        } else if (result.method === 'crawl4ai' || action === 'markdown') {
            // Crawl4AI pushed on every action when requested; Playwright
            // only pushed for markdown actions.
            summarizeAndPushToCanvas(
                result.title || url,
                result.markdown,
                false,
                result.screenshotPath || '',
                options.model
            );
        }
    }
    return result;
}

async function smartBrowse(url, options = {}) {
    const {
        action = 'markdown',
        takeScreenshot = false,
        viewportType = 'desktop',
        pushToCanvas = false
    } = options;

    console.log(`[SmartScraper] Browsing: ${url} (Action: ${action}, Screenshot: ${takeScreenshot}, Viewport: ${viewportType}, PushToCanvas: ${pushToCanvas})`);

    const result = await runSmartBrowsePipeline(url, options);

    if (Array.isArray(result.attempts)) {
        const winner = result.attempts.find(a => a.status === 'success');
        result.attempts.forEach(a => {
            if (a.status === 'failed') {
                console.warn(`[SmartScraper] ${a.engine} attempt failed after ${a.durationMs}ms: ${a.error}`);
            } else {
                console.log(`[SmartScraper] ${a.engine} attempt succeeded in ${a.durationMs}ms`);
            }
        });
        if (result.method === 'all-failed' || !winner) {
            console.error(`[SmartScraper] All scraping engines failed for ${url}`);
        } else {
            console.log(`[SmartScraper] Final engine for ${url}: ${winner.engine}`);
        }
    }

    return result;
}

// 🛡️ TIER 2 (FALLBACK): Playwright-Extra + Readability + Turndown
// Extracted from smartBrowse so it can be driven as one pipeline engine.
// Throws on failure so the orchestrator can degrade to Jina.
async function playwrightBrowse(url, options = {}) {
    const {
        action = 'markdown',
        timeout = 25000,
        maxChars = 15000,
        takeScreenshot = false,
        viewportType = 'desktop',
    } = options;

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
            ]
        });

        // Setup viewport sizes
        const viewports = {
            desktop: { width: 1366, height: 768 },
            mobile: { width: 375, height: 812 },
            tablet: { width: 768, height: 1024 }
        };
        const selectedViewport = viewports[viewportType] || viewports.desktop;

        const context = await browser.newContext({
            userAgent: viewportType === 'mobile'
                ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
                : getRandomUA(),
            viewport: selectedViewport,
            locale: 'en-US',
            timezoneId: 'Asia/Kolkata',
            bypassCSP: true,
            isMobile: viewportType === 'mobile',
            hasTouch: viewportType === 'mobile' || viewportType === 'tablet'
        });

        // Block heavy resources (allow images if taking a screenshot for full visual layout)
        if (takeScreenshot) {
            await context.route('**/*.{woff,woff2,ttf,eot,mp4,mp3,avi}', route => route.abort());
        } else {
            await context.route('**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot,mp4,mp3,avi}', route => route.abort());
        }
        await context.route('**/*google-analytics*', route => route.abort());
        await context.route('**/*googletagmanager*', route => route.abort());
        await context.route('**/*facebook*', route => route.abort());
        await context.route('**/*doubleclick*', route => route.abort());

        const page = await context.newPage();

        // Navigate with robust fallback
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        } catch (e) {
            console.warn(`[SmartScraper] Primary goto failed, retrying...`);
            await page.goto(url, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
        }

        // Wait for content to settle
        await page.waitForSelector('body', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(800);

        let screenshotPath = '';

        // Capture screenshot if requested, and it's a markdown action
        if (takeScreenshot && action === 'markdown') {
            try {
                const title = (await page.title()) || '';
                const bodyText = (await page.evaluate(() => document.body.innerText)) || '';

                const errorKeywords = [
                    'cloudflare', 'access denied', '403 forbidden', '404 not found', 
                    'robot check', 'captcha', 'security check', 'just a moment',
                    'please enable js', 'unauthorized', 'error 403', 'error 404'
                ];

                const isError = errorKeywords.some(keyword => 
                    title.toLowerCase().includes(keyword) || 
                    bodyText.toLowerCase().includes(keyword)
                );

                if (isError) {
                    console.log(`[SmartScraper] Skipping screenshot: Page appears to be an error/blocked page (Title: "${title}")`);
                } else {
                    const filename = `screenshot_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
                    const absolutePath = path.join(__dirname, '..', 'public', 'images', filename);
                    await fs.ensureDir(path.dirname(absolutePath));

                    // Take screenshot in optimized compressed JPEG format
                    await page.screenshot({ 
                        path: absolutePath, 
                        type: 'jpeg', 
                        quality: 75 
                    });
                    
                    screenshotPath = `/images/${filename}`;
                    console.log(`[SmartScraper] Screenshot saved to ${absolutePath}`);

                    // Journal Logging (screenshot_gallery.json)
                    try {
                        const galleryPath = path.join(__dirname, '..', 'brain', 'screenshot_gallery.json');
                        await fs.ensureDir(path.dirname(galleryPath));
                        
                        let gallery = [];
                        if (await fs.pathExists(galleryPath)) {
                            try {
                                gallery = await fs.readJson(galleryPath);
                            } catch (e) {
                                gallery = [];
                            }
                        }

                        gallery.push({
                            url,
                            title: title || 'Untitled',
                            screenshotPath,
                            viewport: viewportType,
                            timestamp: Date.now()
                        });

                        // Limit journal entries to last 100
                        if (gallery.length > 100) {
                            gallery.shift();
                        }

                        await fs.writeJson(galleryPath, gallery, { spaces: 2 });
                    } catch (journalErr) {
                        console.warn(`[SmartScraper] Failed to log to screenshot_gallery.json:`, journalErr.message);
                    }
                }
            } catch (screenshotErr) {
                console.error(`[SmartScraper] Screenshot capture failed: ${screenshotErr.message}`);
            }
        }

        let result = {};

        if (action === 'screenshot') {
            const buffer = await page.screenshot({ fullPage: false });
            result.screenshot = buffer.toString('base64');
        } else if (action === 'dom') {
            result.dom = await page.content();
        } else if (action === 'text') {
            result.text = await page.evaluate(() => document.body.innerText);
        } else {
            // DEFAULT: Smart Markdown extraction
            const html = await page.content();
            const pageUrl = page.url();
            const pageTitle = await page.title();

            result = extractMarkdown(html, pageUrl, pageTitle, maxChars);
            result.screenshotPath = screenshotPath; // Inject screenshot path
        }

        // [UI] Canvas pushes are handled centrally in runSmartBrowsePipeline
        // once the winning engine is known, so nothing is pushed here.

        await browser.close();
        return result;

    } catch (e) {
        console.error(`[SmartScraper] Playwright failed for ${url}: ${e.message}`);
        if (browser) await browser.close().catch(() => {});

        // Throw so the orchestrator records this attempt's failure reason
        // and degrades to the Jina tier.
        throw e;
    }
}

// --- Extract Markdown from raw HTML using Readability + Turndown ---
function extractMarkdown(html, url, title, maxChars = 15000) {
    try {
        const { document } = parseHTML(html);

        // Use Readability to extract article content
        const reader = new Readability(document, {
            charThreshold: 50,
        });
        const article = reader.parse();

        if (article && article.content) {
            let markdown = turndown.turndown(article.content);

            // Clean up excessive whitespace
            markdown = markdown
                .replace(/\n{3,}/g, '\n\n')
                .replace(/^\s+$/gm, '')
                .trim();

            // Truncate if too long (saves LLM tokens)
            if (markdown.length > maxChars) {
                markdown = markdown.substring(0, maxChars) + '\n\n...[Content truncated]';
            }

            return {
                title: article.title || title || 'Untitled',
                markdown: markdown,
                excerpt: article.excerpt || '',
                byline: article.byline || '',
                siteName: article.siteName || '',
                url: url,
                charCount: markdown.length,
                method: 'readability'
            };
        }

        // Readability failed — fall back to body text with Turndown
        const bodyEl = document.querySelector('body');
        if (bodyEl) {
            let markdown = turndown.turndown(bodyEl.innerHTML);
            markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
            if (markdown.length > maxChars) {
                markdown = markdown.substring(0, maxChars) + '\n\n...[Content truncated]';
            }
            return {
                title: title || 'Untitled',
                markdown: markdown,
                url: url,
                charCount: markdown.length,
                method: 'turndown-fallback'
            };
        }

        return { title: title || 'Untitled', markdown: 'Could not extract content.', url, method: 'failed' };

    } catch (e) {
        console.error(`[SmartScraper] Markdown extraction error: ${e.message}`);
        return { title: title || 'Untitled', markdown: `Extraction failed: ${e.message}`, url, method: 'error' };
    }
}


// --- Jina.ai Reader Tier 3 (100% Free, No API Key) ---
// Pipeline engine variant: returns the result on success and THROWS on
// failure so the orchestrator can record the reason and produce the
// all-failed result with a complete attempts trail.
async function jinaFetch(url, maxChars = 15000) {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await axios.get(jinaUrl, {
        headers: {
            'Accept': 'text/plain',
            'User-Agent': getRandomUA(),
        },
        timeout: 20000,
    });

    let markdown = response.data || '';
    if (markdown.length > maxChars) {
        markdown = markdown.substring(0, maxChars) + '\n\n...[Content truncated]';
    }

    return {
        title: 'Jina Reader Result',
        markdown: markdown,
        url: url,
        charCount: markdown.length,
        method: 'jina-fallback'
    };
}

// --- Jina.ai Reader Fallback (standalone /api/web/jina endpoint) ---
// Keeps the original never-throwing contract and canvas push behaviour.
async function jinaFallback(url, maxChars = 15000, pushToCanvas = false, modelOverride = null) {
    try {
        const result = await jinaFetch(url, maxChars);

        // [UI] Push to Canvas only if explicitly requested
        if (pushToCanvas) {
            summarizeAndPushToCanvas(result.title, result.markdown, true, '', modelOverride);
        }

        return result;
    } catch (e) {
        console.error(`[SmartScraper] Jina fallback also failed: ${e.message}`);
        return {
            title: 'Error',
            markdown: `All extraction methods failed for ${url}. Error: ${e.message}`,
            url: url,
            method: 'all-failed'
        };
    }
}


// --- DEEP RESEARCH: Search + Crawl Top N Links + Merge ---
async function deepResearch(query, options = {}) {
    const { 
        maxLinks = 3, 
        maxCharsPerPage = 8000, 
        recency = 'all',
        takeScreenshot = false,
        viewportType = 'desktop'
    } = options;
    const backendUrl = `http://localhost:${process.env.PORT || 3000}`;

    console.log(`[DeepResearch] Starting deep research for: "${query}" (Recency: ${recency}, Screenshot: ${takeScreenshot}, Viewport: ${viewportType})`);

    try {
        // Step 1: Run search to get links
        const searchRes = await axios.post(`${backendUrl}/api/web/search`, {
            query: query,
            limit: maxLinks + 2, // Get a few extra in case some fail
            recency: recency
        });

        const searchResults = searchRes.data.results || [];
        if (searchResults.length === 0) {
            return {
                query,
                summary: 'No search results found for this query.',
                sources: [],
                totalChars: 0
            };
        }

        // Step 2: Pick top N unique URLs
        const urls = [];
        const seen = new Set();
        for (const r of searchResults) {
            if (r.url && !seen.has(r.url) && urls.length < maxLinks) {
                // Skip search engine result pages, PDFs, etc.
                if (r.url.includes('google.com/search') || r.url.endsWith('.pdf')) continue;
                seen.add(r.url);
                urls.push({ url: r.url, title: r.title || 'Source' });
            }
        }

        console.log(`[DeepResearch] Crawling ${urls.length} sources...`);

        // Step 3: Crawl all links in parallel (Smart Markdown)
        const crawlTasks = urls.map(u =>
            smartBrowse(u.url, {
                action: 'markdown',
                maxChars: maxCharsPerPage,
                takeScreenshot,
                viewportType
            })
                .then(result => ({ ...result, searchTitle: u.title }))
                .catch(e => ({
                    title: u.title,
                    markdown: `Failed to crawl: ${e.message}`,
                    url: u.url,
                    method: 'error',
                    attempts: []
                }))
        );

        const crawlResults = await Promise.allSettled(crawlTasks);

        // Step 4: Normalize results (each source keeps its own attempts
        // trail) then merge into one structured research document. The
        // report text format is produced by the shared pure merger and is
        // unchanged from the previous implementation.
        const items = crawlResults.map((result, i) =>
            result.status === 'fulfilled' ? result.value : {
                title: urls[i]?.title || 'Unknown',
                searchTitle: urls[i]?.title,
                markdown: 'Crawl failed.',
                url: urls[i]?.url || '',
                method: 'error',
                attempts: []
            }
        );

        const { report: mergedReport, sources, totalChars } = mergeDeepResearchResults(query, items);

        console.log(`[DeepResearch] Complete. ${sources.length} sources, ${totalChars} total chars.`);

        // [UI] Push to Canvas for a premium and interactive research experience
        try {
            const { pushToCanvas } = require('./canvasBridge');
            pushToCanvas({
                id: `research_${Date.now()}`,
                type: 'markdown',
                label: 'DEEP RESEARCH REPORT',
                title: query,
                content: mergedReport
            });
        } catch (uiErr) {
            console.warn(`[DeepResearch] UI Sync failed (non-critical):`, uiErr.message);
        }

        return {
            query,
            report: mergedReport,
            sources,
            totalChars
        };

    } catch (e) {
        console.error(`[DeepResearch] Critical error: ${e.message}`);
        return {
            query,
            report: `Deep Research failed: ${e.message}`,
            sources: [],
            totalChars: 0
        };
    }
}


module.exports = {
    smartBrowse,
    runSmartBrowsePipeline,
    extractMarkdown,
    jinaFallback,
    jinaFetch,
    crawlWithCrawl4AI,
    playwrightBrowse,
    deepResearch,
    getRandomUA
};
