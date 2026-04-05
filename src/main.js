/**
 * Kickstarter Pre-Launch Follower Tracker
 *
 * Scrapes a Kickstarter project page (pre-launch or live) and extracts:
 * - Follower / "Notify Me" count
 * - Project name, creator, category, description, and location
 *
 * Works with both pre-launch pages and live campaign pages.
 * Uses Playwright for client-side rendered content.
 *
 * Monetization: Pay Per Event (PPE) at $0.01 per successful scrape.
 * The charge is triggered via Actor.pushData(result, 'project-scraped').
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

await Actor.init();

// ---------- Input ----------
const input = await Actor.getInput() ?? {};
const {
    url,
    waitForSelectorTimeout = 30000,
    proxyConfiguration: proxyConfig,
} = input;

if (!url) {
    throw new Error(
        'Missing required input "url". Please provide a Kickstarter project URL.',
    );
}

// Validate URL
const ksUrlPattern = /^https?:\/\/(www\.)?kickstarter\.com\/projects\/.+/i;
if (!ksUrlPattern.test(url)) {
    throw new Error(
        `Invalid URL: "${url}". Please provide a valid Kickstarter project URL ` +
        '(e.g. https://www.kickstarter.com/projects/creator-name/project-name)',
    );
}

// Normalise to www
const normalizedUrl = url.replace(
    /^https?:\/\/kickstarter\.com/,
    'https://www.kickstarter.com',
);

const normalizeProjectName = (projectName) => projectName
    ?.replace(/^coming\s+soon:\s*/i, '')
    ?.trim() ?? null;

// ---------- Proxy (default to residential for anti-bot bypass) ----------
const proxyConfiguration = await Actor.createProxyConfiguration(
    proxyConfig ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
);

// ---------- PPE: Check charging mode ----------
const chargingManager = Actor.getChargingManager();
const pricingInfo = chargingManager.getPricingInfo();
const isPPE = pricingInfo.isPayPerEvent;

if (isPPE) {
    log.info('Running in Pay Per Event mode. Event: "project-scraped" ($0.01)');
}

// ---------- Locator helper with short timeout ----------
const LOCATOR_TIMEOUT = 5000;

const safeTextContent = (locator) =>
    locator.first().textContent({ timeout: LOCATOR_TIMEOUT }).then((t) => t?.trim()).catch(() => null);

const safeGetAttribute = (locator, attr) =>
    locator.first().getAttribute(attr, { timeout: LOCATOR_TIMEOUT }).catch(() => null);

// ---------- Crawler ----------
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    headless: true,
    navigationTimeoutSecs: Math.ceil(waitForSelectorTimeout / 1000),
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 3,
    launchContext: {
        launcher: chromium,
        launchOptions: {
            args: [
                '--disable-gpu',
                '--no-sandbox',
                '--disable-setuid-sandbox',
            ],
        },
    },

    async requestHandler({ page, request }) {
        log.info(`Scraping ${request.url}`);

        // Wait for the main content to render
        await page.waitForLoadState('networkidle', {
            timeout: waitForSelectorTimeout,
        }).catch(() => {
            log.warning('networkidle timed out — continuing with current state');
        });

        // Give React/Next.js a moment to hydrate
        await page.waitForTimeout(3000);

        // ------------------------------------------------------------------
        // Anti-bot detection: check if we landed on a challenge page
        // ------------------------------------------------------------------
        const blocked = await page.evaluate(() => {
            const title = document.title?.toLowerCase() ?? '';
            const body = document.body?.innerText?.toLowerCase() ?? '';
            if (title.includes('just a moment') || title.includes('attention required')) return 'cloudflare';
            if (body.includes('verify you are human') || body.includes('enable javascript and cookies')) return 'challenge';
            if (document.querySelector('#challenge-running, #challenge-form, .cf-browser-verification')) return 'cloudflare-dom';
            return null;
        });

        if (blocked) {
            const kvStore = await Actor.openKeyValueStore();
            const screenshot = await page.screenshot({ fullPage: true });
            await kvStore.setValue('BLOCKED-PAGE', screenshot, { contentType: 'image/png' });
            const html = await page.content();
            await kvStore.setValue('BLOCKED-HTML', html, { contentType: 'text/html' });
            log.warning(`Anti-bot challenge detected (${blocked}). Screenshot saved to key-value store as BLOCKED-PAGE.`);
            throw new Error(`Blocked by anti-bot protection: ${blocked}. Check BLOCKED-PAGE in key-value store for screenshot.`);
        }

        const result = {
            url: request.url,
            projectName: null,
            creatorName: null,
            category: null,
            subcategory: null,
            description: null,
            followerCount: null,
            location: null,
            backerCount: null,
            scrapedAt: new Date().toISOString(),
        };

        // ------------------------------------------------------------------
        // Strategy 1: Try extracting from embedded JSON data
        // ------------------------------------------------------------------
        const jsonData = await page.evaluate(() => {
            const nextDataEl = document.querySelector('#__NEXT_DATA__');
            if (nextDataEl) {
                try {
                    return { source: 'nextdata', data: JSON.parse(nextDataEl.textContent) };
                } catch { /* ignore */ }
            }

            const initialDataEl = document.querySelector('[data-initial]');
            if (initialDataEl) {
                try {
                    return { source: 'datainitial', data: JSON.parse(initialDataEl.getAttribute('data-initial')) };
                } catch { /* ignore */ }
            }

            if (window.current_project) {
                return { source: 'global', data: window.current_project };
            }

            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const text = script.textContent || '';
                if (text.includes('"watchesCount"') || text.includes('"prelaunch_activated"') || text.includes('"is_launched"')) {
                    try {
                        const match = text.match(/\{[^{}]*"watchesCount"[^}]*\}/);
                        if (match) return { source: 'script_watches', data: JSON.parse(match[0]) };
                    } catch { /* ignore */ }
                    return { source: 'script_raw', data: text };
                }
            }

            return null;
        });

        if (jsonData) {
            log.info(`Found structured data via: ${jsonData.source}`);
            try {
                const d = jsonData.data;
                if (jsonData.source === 'nextdata') {
                    const project =
                        d?.props?.pageProps?.project ??
                        d?.props?.pageProps?.campaign ??
                        d?.props?.pageProps?.data?.project ??
                        null;
                    if (project) {
                        result.projectName = project.name ?? project.title ?? null;
                        result.creatorName = project.creator?.name ?? null;
                        result.category = project.category?.name ?? project.category?.parentCategory?.name ?? null;
                        result.subcategory = project.category?.parentCategory?.name ?? null;
                        result.description = project.blurb ?? project.description ?? null;
                        result.followerCount = project.watchesCount ?? project.prelaunchFollowerCount ?? null;
                        result.location = project.location?.displayableName ?? project.location?.name ?? null;
                        result.backerCount = project.backersCount ?? null;
                    }
                } else if (jsonData.source === 'global') {
                    const project =
                        d?.data?.project ??
                        d?.data ??
                        d;
                    if (project) {
                        result.projectName = project.name ?? project.title ?? null;
                        result.creatorName =
                            project.creator?.name ??
                            project.creator_name ??
                            project.owner?.name ??
                            null;
                        result.category =
                            project.subcategory?.name ??
                            project.subcategory_name ??
                            project.category?.name ??
                            project.category_name ??
                            null;
                        result.subcategory =
                            project.category?.name ??
                            project.category_name ??
                            null;
                        result.description = project.blurb ?? project.description ?? null;
                        result.followerCount = project.watchesCount ?? project.prelaunchFollowerCount ?? null;
                        result.location =
                            project.location?.displayableName ??
                            project.location?.name ??
                            project.location_name ??
                            (typeof project.location === 'string' ? project.location : null) ??
                            null;
                        result.backerCount = project.backersCount ?? null;
                    }
                }
            } catch (e) {
                log.warning(`Error parsing structured data: ${e.message}`);
            }
        }

        // ------------------------------------------------------------------
        // Strategy 2: DOM scraping fallback
        // ------------------------------------------------------------------
        if (!result.projectName) {
            result.projectName = await page
                .locator('h2[class*="project-name"], h1[class*="project-name"], [data-test-id="project-name"], .project-name, meta[property="og:title"]')
                .first()
                .evaluate((el) => el.tagName === 'META' ? el.content : el.textContent?.trim(), { timeout: LOCATOR_TIMEOUT })
                .catch(() => null);
        }

        if (!result.projectName) {
            result.projectName = await safeGetAttribute(
                page.locator('meta[property="og:title"]'), 'content',
            );
        }

        const titleCreator = await page
            .title()
            .then((title) => {
                const match = title.match(/\bby\s+(.+?)(?:\s[—\-|:]|\s*\|)/i);
                return match?.[1]?.trim() ?? null;
            })
            .catch(() => null);

        if (!result.creatorName && titleCreator) {
            result.creatorName = titleCreator;
        }

        const contextualMetadata = await page
            .evaluate((projectName) => {
                if (!projectName) return { creatorName: null, category: null };

                const normalizedName = projectName.trim().toLowerCase();
                const titleNode = Array.from(document.querySelectorAll('main h1, main h2, h1, h2'))
                    .find((node) => {
                        const text = node.textContent?.trim().toLowerCase();
                        return text && (text === normalizedName || text.includes(normalizedName));
                    });

                if (!titleNode) return { creatorName: null, category: null };

                const candidates = [];
                let container = titleNode.closest('section, article, main, div');
                for (let i = 0; i < 4 && container; i += 1) {
                    candidates.push(container);
                    container = container.parentElement;
                }

                const pickFromContainers = (selector, post = (text) => text) => {
                    for (const el of candidates) {
                        const found = Array.from(el.querySelectorAll(selector))
                            .map((node) => node.textContent?.trim())
                            .map((text) => (text ? post(text) : null))
                            .find(Boolean);
                        if (found) return found;
                    }
                    return null;
                };

                const creatorName =
                    pickFromContainers('[data-test-id="creator-name"], [data-test-id="creator-info"] a, a[href*="/profile/"]') ??
                    pickFromContainers('*', (text) => {
                        const match = text.match(/\bby\s+([A-Z][\w\s'.-]{2,80})/i);
                        return match?.[1]?.trim() ?? null;
                    });

                const category = pickFromContainers('a[href*="/discover/categories/"]');

                return { creatorName, category };
            }, result.projectName)
            .catch(() => ({ creatorName: null, category: null }));

        const metadataFromLdJson = await page
            .evaluate(() => {
                const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                const asArray = (value) => {
                    if (!value) return [];
                    return Array.isArray(value) ? value : [value];
                };

                const queue = [];
                for (const script of scripts) {
                    if (!script.textContent) continue;
                    try {
                        const parsed = JSON.parse(script.textContent);
                        queue.push(...asArray(parsed));
                    } catch {
                        // ignore invalid JSON-LD blocks
                    }
                }

                let creatorName = null;
                let category = null;

                while (queue.length > 0) {
                    const item = queue.shift();
                    if (!item || typeof item !== 'object') continue;

                    const creatorCandidate =
                        item.creator?.name ??
                        item.author?.name ??
                        item.brand?.name ??
                        null;
                    if (!creatorName && typeof creatorCandidate === 'string') {
                        creatorName = creatorCandidate.trim();
                    }

                    const categoryCandidate =
                        item.genre ??
                        item.category ??
                        null;
                    if (!category && typeof categoryCandidate === 'string') {
                        category = categoryCandidate.trim();
                    }

                    for (const value of Object.values(item)) {
                        if (value && typeof value === 'object') {
                            queue.push(...asArray(value));
                        }
                    }
                }

                return {
                    creatorName,
                    category,
                };
            })
            .catch(() => ({ creatorName: null, category: null }));

        if (!result.creatorName && contextualMetadata.creatorName) {
            result.creatorName = contextualMetadata.creatorName;
        }

        const metadataCreatorName = await page
            .evaluate(() => {
                const pickText = (nodes) => nodes
                    .map((node) => node.textContent?.trim())
                    .find((text) => text && text.length <= 80);

                const directCreator = pickText(Array.from(document.querySelectorAll(
                    'main [data-test-id="creator-name"], main [data-test-id="creator-info"] a, main a[href*="/profile/"]',
                )));
                if (directCreator) return directCreator;

                const bylineEl = document.querySelector('main [data-test-id*="creator" i], main [class*="creator" i], main');
                const bylineText = bylineEl?.textContent ?? '';
                const byMatch = bylineText.match(/\bby\s+([A-Z][\w\s'.-]{2,80})/i);
                return byMatch?.[1]?.trim() ?? null;
            })
            .catch(() => null);

        if (!result.creatorName && metadataFromLdJson.creatorName) {
            result.creatorName = metadataFromLdJson.creatorName;
        }

        if (!result.category && metadataFromLdJson.category) {
            result.category = metadataFromLdJson.category;
        }

        if (!result.category && contextualMetadata.category) {
            result.category = contextualMetadata.category;
        }

        if (!result.creatorName && metadataCreatorName) {
            result.creatorName = metadataCreatorName;
        } else if (!result.creatorName) {
            result.creatorName = await safeTextContent(
                page.locator('[data-test-id="creator-name"], [data-test-id="creator-info"] a, [class*="creator"] a, .creator-name a'),
            );
        }

        if (!result.description) {
            result.description = await safeGetAttribute(
                page.locator('meta[property="og:description"]'), 'content',
            );
        }

        const metadataCategory = await page
            .evaluate(() => {
                const categoryLinks = Array.from(document.querySelectorAll(
                    '[data-test-id="project-metadata"] a[href*="/discover/categories/"], [data-test-id="project-category"] a, [class*="metadata"] a[href*="/discover/categories/"]',
                ));
                const names = categoryLinks
                    .map((link) => link.textContent?.trim())
                    .filter((text) => text && !/^category$/i.test(text));

                if (names.length === 0) return null;
                return names[names.length - 1];
            })
            .catch(() => null);

        const mainCategory = await page
            .evaluate(() => {
                const categoryLinks = Array.from(document.querySelectorAll('main a[href*="/discover/categories/"]'));
                const names = categoryLinks
                    .map((link) => link.textContent?.trim())
                    .filter((text) => text && !/^category$/i.test(text));
                if (names.length === 0) return null;
                return names[names.length - 1];
            })
            .catch(() => null);

        if (!result.category) {
            if (metadataCategory) {
                result.category = metadataCategory;
            } else if (mainCategory) {
                result.category = mainCategory;
            } else {
                result.category = await safeTextContent(
                    page.locator('a[href*="/discover/categories/"]'),
                );
            }
        }

        // ------------------------------------------------------------------
        // Strategy 3: Follower count from visible DOM
        // ------------------------------------------------------------------
        if (result.followerCount === null) {
            const followerText = await page.evaluate(() => {
                const body = document.body.innerText;

                const patterns = [
                    /(\d[\d,]*)\s*followers?/i,
                    /(\d[\d,]*)\s*people/i,
                    /(\d[\d,]*)\s*notif/i,
                    /(\d[\d,]*)\s*watchers?/i,
                ];

                for (const pattern of patterns) {
                    const match = body.match(pattern);
                    if (match) return match[1];
                }

                const notifyBtn = document.querySelector(
                    'button[class*="notify"], button[class*="follow"], [data-test-id*="notify"], [data-test-id*="follow"]',
                );
                if (notifyBtn) {
                    const parent = notifyBtn.closest('div') ?? notifyBtn.parentElement;
                    if (parent) {
                        const numMatch = parent.textContent.match(/(\d[\d,]*)/);
                        if (numMatch) return numMatch[1];
                    }
                }

                return null;
            });

            if (followerText) {
                result.followerCount = parseInt(followerText.replace(/,/g, ''), 10);
            }
        }

        // ------------------------------------------------------------------
        // Strategy 4: Live project backer/funding data from DOM
        // ------------------------------------------------------------------
        if (!result.backerCount) {
            const backerText = await safeTextContent(
                page.locator('[data-test-id="backers-count"], [class*="backers"] .count, #backers_count'),
            );

            if (backerText) {
                const parsed = parseInt(backerText.replace(/[^0-9]/g, ''), 10);
                if (!isNaN(parsed)) result.backerCount = parsed;
            }
        }

        // ------------------------------------------------------------------
        // Location fallback
        // ------------------------------------------------------------------
        if (!result.location) {
            result.location = await safeTextContent(
                page.locator('[class*="location"], [data-test-id="project-location"]'),
            );
        }

        result.projectName = normalizeProjectName(result.projectName);

        // ------------------------------------------------------------------
        // Push results + charge PPE event
        // ------------------------------------------------------------------
        log.info('Extracted data:', {
            projectName: result.projectName,
            creatorName: result.creatorName,
            category: result.category,
            followerCount: result.followerCount,
        });

        // The second argument 'project-scraped' is the PPE event name.
        // In PPE mode: triggers a $0.01 charge per successful scrape.
        // Outside PPE mode (local / free users): event name is ignored.
        await Actor.pushData(result, 'project-scraped');

        log.info('Data pushed to dataset. PPE event "project-scraped" charged (if PPE mode).');
    },

    async failedRequestHandler({ request, page }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
        if (page) {
            try {
                const kvStore = await Actor.openKeyValueStore();
                const screenshot = await page.screenshot({ fullPage: true });
                await kvStore.setValue('FAILED-PAGE', screenshot, { contentType: 'image/png' });
                log.info('Failure screenshot saved to key-value store as FAILED-PAGE.');
            } catch (e) {
                log.warning(`Could not capture failure screenshot: ${e.message}`);
            }
        }
    },
});

// ---------- Run ----------
await crawler.run([normalizedUrl]);

log.info('Done. Results pushed to dataset.');
await Actor.exit();
