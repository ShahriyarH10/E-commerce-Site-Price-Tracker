const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // hosting platforms sit behind a proxy; this makes req.ip the visitor's address
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Each search spends Serper credits and fetches many pages, so cap searches per visitor
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const searchLog = new Map();

function rateLimit(req, res, next) {
    const now = Date.now();
    const recent = (searchLog.get(req.ip) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
        return res.status(429).json({ error: 'Too many searches. Please wait a few minutes and try again.' });
    }
    recent.push(now);
    searchLog.set(req.ip, recent);
    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of searchLog) {
        if (times.every(t => now - t >= RATE_WINDOW_MS)) searchLog.delete(ip);
    }
}, RATE_WINDOW_MS).unref();

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const cleanPrice = (priceStr) => {
    if (!priceStr) return 0;
    // Only the first number counts, so "1,250.00" stays 1250 and "৳240 ৳300" doesn't merge into 240300
    const number = priceStr.match(/\d[\d,]*/);
    return number ? parseInt(number[0].replace(/,/g, ''), 10) : 0;
};

// Star Tech serves its results as plain HTML, so no browser is needed
async function scrapeStartech(query) {
    try {
        const url = `https://www.startech.com.bd/product/search?search=${encodeURIComponent(query)}`;
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`Star Tech responded ${response.status}`);
        const $ = cheerio.load(await response.text());
        return $('.p-item').slice(0, 10).toArray().map((el) => {
            const item = $(el);
            const title = item.find('.p-item-name a').first();
            const priceNew = item.find('.p-item-price .price-new').first().text();
            const priceOld = item.find('.p-item-price span').first().text();
            return {
                store: 'Star Tech',
                name: title.text().trim(),
                price: cleanPrice(priceNew || priceOld),
                link: title.attr('href') || '#',
                image: item.find('.p-item-img img').attr('src') || 'https://placehold.co/150',
                delivery: 'Delivery: ৳60'
            };
        }).filter(p => p.price > 0 && p.name);
    } catch (e) {
        console.log(`Star Tech scrape failed: ${e.message}`);
        return [];
    }
}

// Ryans blocks automated browsers, so its listings come from Google results via Serper.dev (needs SERPER_API_KEY in .env)
async function searchRyans(query) {
    if (!process.env.SERPER_API_KEY) return [];
    try {
        const response = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: `site:ryans.com ${query}`, gl: 'bd', num: 10 }),
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error(`Serper responded ${response.status}`);
        const data = await response.json();
        return (data.organic || [])
            // Google appends tracking parameters (?srsltid=...), so compare on the bare URL
            .map(r => ({ ...r, link: r.link.split(/[?#]/)[0] }))
            // Skip category, brand and search listing pages; product pages sit directly under the domain
            .filter(r => /^https:\/\/www\.ryans\.com\/[^/]+$/.test(r.link))
            .map(r => {
                // Ryans product snippets read "The price of <product> starts from 820". Other "Tk" amounts in a
                // snippet can belong to related products listed on the page, so only this phrasing is trusted.
                const priceMatch = (r.snippet || '').match(/price of .+? starts from (?:tk\.?\s*|৳\s*)?([\d,]+)/i);
                return {
                    store: 'Ryans Computers',
                    name: r.title.replace(/\s*[|\-–]\s*Ryans.*$/i, '').replace(/\s*Price in (Bangladesh|BD).*$/i, '').trim(),
                    price: priceMatch ? cleanPrice(priceMatch[1]) : null,
                    link: r.link,
                    image: r.imageUrl || 'https://placehold.co/150',
                    delivery: 'Check site'
                };
            })
            .filter(p => p.name);
    } catch (e) {
        console.log(`Ryans search failed: ${e.message}`);
        return [];
    }
}

// Every other Bangladeshi shop is found through one Google search via Serper; the stores above have their own scrapers
const SCRAPED_DOMAINS = ['startech.com.bd', 'ryans.com', 'daraz.com.bd'];
const NON_RETAILER_DOMAINS = ['facebook.com', 'youtube.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'linkedin.com',
    'pinterest.com', 'reddit.com', 'quora.com', 'wikipedia.org', 'amazon.com', 'aliexpress.com', 'ebay.com', 'bikroy.com'];
const STORE_NAMES = {
    'techlandbd.com': 'Techland BD', 'pickaboo.com': 'Pickaboo', 'applegadgetsbd.com': 'Apple Gadgets', 'gadgetandgear.com': 'Gadget & Gear',
    'computervillage.com.bd': 'Computer Village', 'pqs.com.bd': 'PQS', 'smartbd.com': 'SmartBD', 'computersource.com.bd': 'Computer Source',
    'othoba.com': 'Othoba', 'chaldal.com': 'Chaldal', 'shwapno.com': 'Shwapno', 'ucc-bd.com': 'UCC', 'vertech.com.bd': 'Vertech',
    'globalbrand.com.bd': 'Global Brand', 'skyland.com.bd': 'Skyland', 'binarylogic.com.bd': 'Binary Logic', 'sumashtech.com': 'Sumash Tech'
};

// Snippets state prices as "is 820৳", "starts from 820", "৳ 849.00" or "Tk 795"; returns null when none is found.
// Amounts next to "EMI" or "month" are installments, not the product price, so they are skipped.
const priceFromSnippet = (snippet) => {
    const patterns = [
        /price[^.]*?\b(?:is|from)\s+(?:৳|tk\.?|bdt)?\s*([\d,]+(?:\.\d+)?)/gi,
        /(?:৳|tk\.?|bdt)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:৳|tk\b|bdt)/gi
    ];
    for (const pattern of patterns) {
        for (const match of snippet.matchAll(pattern)) {
            const context = snippet.slice(Math.max(0, match.index - 10), match.index + match[0].length + 12);
            if (/emi|month|\/\s*mo\b/i.test(context)) continue;
            const price = Math.round(parseFloat((match[1] || match[2]).replace(/,/g, '')));
            if (price >= 10) return price;
        }
    }
    return null;
};

// Blog posts and category pages mention prices, but not the price of one product
const isListingOrArticle = (link) => {
    const path = new URL(link).pathname;
    return /\/(blog|news|category|product-category|tag|collections)(\/|$)/i.test(path) && !/\/products\//i.test(path);
};

// Reads the price a product page declares for itself (schema.org JSON-LD, then meta tags); returns null when there is none.
// Pages with several Product entries are listings, so none of those prices can be trusted for this result.
const priceFromPage = (html) => {
    const products = [];
    const collect = (node) => {
        if (Array.isArray(node)) return node.forEach(collect);
        if (!node || typeof node !== 'object') return;
        if (node['@graph']) collect(node['@graph']);
        if ([].concat(node['@type'] || []).includes('Product')) products.push(node);
    };
    for (const [, json] of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            collect(JSON.parse(json));
        } catch {
            // Shops sometimes publish malformed JSON-LD; the meta tags below may still have the price
        }
    }
    if (products.length > 1) return null;

    const prices = [].concat(products[0]?.offers || [])
        .filter(offer => !offer.priceCurrency || offer.priceCurrency === 'BDT')
        .map(offer => parseFloat(String(offer.price ?? offer.lowPrice).replace(/,/g, '')))
        .filter(price => price >= 10);
    if (prices.length) return Math.round(Math.min(...prices));

    const meta = html.match(/(?:product:price:amount|og:price:amount)"[^>]*content="([^"]+)"/i);
    const metaPrice = meta ? parseFloat(meta[1].replace(/,/g, '')) : 0;
    return metaPrice >= 10 ? Math.round(metaPrice) : null;
};

async function fetchPagePrice(link) {
    try {
        const response = await fetch(link, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(8000)
        });
        return response.ok ? priceFromPage(await response.text()) : null;
    } catch (e) {
        console.log(`Price check failed for ${link}: ${e.message}`);
        return null;
    }
}

async function searchOtherRetailers(query) {
    if (!process.env.SERPER_API_KEY) return [];
    try {
        const response = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: `${query} price in bangladesh`, gl: 'bd', num: 20 }),
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error(`Serper responded ${response.status}`);
        const data = await response.json();
        const candidates = (data.organic || [])
            .map(r => {
                const link = r.link.split(/[?#]/)[0];
                const domain = new URL(link).hostname.replace(/^www\./, '');
                return {
                    store: STORE_NAMES[domain] || domain,
                    domain,
                    name: r.title.replace(/\s*(best\s+)?Price in (Bangladesh|BD).*$/i, '').replace(/\s+[|\-–]\s+[^|\-–]*$/, m => /\d/.test(m) ? m : '').trim(),
                    price: priceFromSnippet(r.snippet || ''),
                    link,
                    image: r.imageUrl || 'https://placehold.co/150',
                    delivery: 'Check site'
                };
            })
            // Pages without a stated price are usually reviews, news or category pages rather than product listings
            .filter(p => p.price && p.name
                && !isListingOrArticle(p.link)
                && !SCRAPED_DOMAINS.some(d => p.domain.endsWith(d))
                && !NON_RETAILER_DOMAINS.some(d => p.domain.endsWith(d)));
        // Snippets can be outdated or quote old prices and installments, so the displayed price comes from the page itself
        return await Promise.all(candidates.map(async ({ domain, ...p }) => ({ ...p, price: await fetchPagePrice(p.link) })));
    } catch (e) {
        console.log(`Retailer search failed: ${e.message}`);
        return [];
    }
}

// Daraz serves its search results as JSON, so no browser is needed
async function scrapeDaraz(query) {
    try {
        const url = `https://www.daraz.com.bd/catalog/?ajax=true&q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
            signal: AbortSignal.timeout(30000)
        });
        const data = await response.json();
        const items = data?.mods?.listItems || [];
        return items.slice(0, 10).map(item => ({
            store: 'Daraz',
            name: item.name,
            price: cleanPrice(String(item.price)),
            link: item.itemUrl?.startsWith('//') ? `https:${item.itemUrl}` : item.itemUrl,
            image: item.image || 'https://placehold.co/150',
            delivery: 'Check site'
        })).filter(p => p.price > 0 && p.name && p.link);
    } catch (e) {
        console.log(`Daraz scrape failed: ${e.message}`);
        return [];
    }
}

const SOURCES = {
    startech: scrapeStartech,
    ryans: searchRyans,
    daraz: scrapeDaraz,
    others: searchOtherRetailers
};

// Lowercases and unifies spellings so "13.6-inch", '13"' and "13 inches" all read as "13.6 inch" / "13 inch"
const normalize = (text) => text.toLowerCase()
    .replace(/["”″]/g, ' inch ')
    .replace(/\binch(es|e)?\b/g, 'inch')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9.+]+/g, ' ')
    .trim();

// Words that mark an add-on rather than the product itself; a result naming one is dropped unless the search names it too
const ACCESSORY_WORDS = ['case', 'cover', 'sleeve', 'skin', 'protector', 'guard', 'tempered', 'film', 'sticker', 'decal', 'pouch',
    'bag', 'backpack', 'shell', 'stand', 'holder', 'mount', 'strap', 'hub', 'dock', 'cable', 'charger', 'adapter', 'adaptor',
    'replacement', 'compatible'];

const startsWord = (text, word) => new RegExp(`(^| )${word.replace(/[.+]/g, '\\$&')}`).test(text);

function matchesQuery(name, searchWords) {
    const text = normalize(name);
    if (!searchWords.every(word => startsWord(text, word))) return false;
    // Searching for an accessory itself ("iphone 15 case") keeps accessories
    if (searchWords.some(w => ACCESSORY_WORDS.some(word => w.startsWith(word)))) return true;
    const words = text.split(' ');
    if (ACCESSORY_WORDS.some(word => words.includes(word) || words.includes(`${word}s`))) return false;
    // "Charger for MacBook Air" names the device only after "for", which marks an accessory for it
    const forIndex = text.indexOf(' for ');
    return forIndex === -1 || startsWord(text.slice(0, forIndex), searchWords[0]);
}

app.get(['/api/search', '/api/compare'], rateLimit, async (req, res) => {
    const productQuery = (req.query.q || req.query.product || '').trim();

    if (!productQuery) {
        return res.status(400).json({ error: 'Please provide a search query parameter.' });
    }

    // Without a sites parameter every source is searched
    const requested = req.query.sites ? String(req.query.sites).split(',') : Object.keys(SOURCES);
    const sources = requested.filter(site => SOURCES[site]);
    if (!sources.length) {
        return res.status(400).json({ error: 'Please select at least one site.' });
    }

    const searchWords = normalize(productQuery).split(' ');
    // Stores search better with standard spellings, e.g. "13 inche" becomes "13 inch"
    const storeQuery = searchWords.join(' ');

    console.log(`\n🔍 Request received for: "${productQuery}" on ${sources.join(', ')}`);

    // Only real listings are returned, so every "Go to Store" link opens an actual product page
    // Each source handles its own errors, so one failing store still leaves the others' results
    let finalResults = (await Promise.all(sources.map(site => SOURCES[site](storeQuery)))).flat();

    // Stores also return loosely related items (accessories, other models), so keep only the product that was searched for
    finalResults = finalResults.filter(item => matchesQuery(item.name, searchWords));

    console.log(`Found ${finalResults.length} live results.`);

    // Sort cheapest first; listings without a known price go last
    finalResults.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

    if (req.path === '/api/search') {
        return res.json(finalResults);
    }

    res.json({
        search_keyword: productQuery,
        total_results: finalResults.length,
        deals: finalResults
    });
});


app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});