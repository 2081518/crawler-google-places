const Apify = require('apify');
const { sleep } = Apify.utils;
const { injectJQuery } = Apify.utils.puppeteer;
const { MAX_PAGE_RETRIES, DEFAULT_TIMEOUT, LISTING_PAGINATION_KEY } = require('./consts');

const waitForGoogleMapLoader = (page) => page.waitFor(() => !document.querySelector('#searchbox').classList.contains('loading'), { timeout: DEFAULT_TIMEOUT });

const enqueueAllUrlsFromPagination = async (page, requestQueue) => {
    let results = await page.$$('.section-result');
    const resultsCount = results.length;
    for (let resultIndex = 0; resultIndex < resultsCount; resultIndex++) {
        // Need to get results again, pupptr lost context..
        await page.waitForSelector('.searchbox', { timeout: DEFAULT_TIMEOUT });
        await waitForGoogleMapLoader(page);
        await page.waitFor((resultIndex) => {
            return document.querySelectorAll('.section-result h3').length >= resultIndex + 1;
        }, { timeout: DEFAULT_TIMEOUT }, resultIndex);
        results = await page.$$('.section-result');
        const link = await results[resultIndex].$('h3');
        await link.click();
        await waitForGoogleMapLoader(page);
        await page.waitForSelector('.section-back-to-list-button', { timeout: DEFAULT_TIMEOUT });
        const url = page.url();
        await requestQueue.addRequest({ url, userData: { label: 'detail' } });
        console.log(`Added to queue ${url}`);
        await page.click('.section-back-to-list-button');
    }
};

/**
 * Crawler add all place detail from listing to queue
 * @param startUrl
 * @param searchString
 * @param launchPuppeteerOptions
 * @param requestQueue
 * @param listingPagination
 * @param retries
 */
const enqueueAllPlaceDetailsCrawler = async (startUrl, searchString, launchPuppeteerOptions, requestQueue, listingPagination, retries = 0) => {
    let browser;
    try {
        browser = await Apify.launchPuppeteer(launchPuppeteerOptions);
        const page = await browser.newPage();
        await page._client.send('Emulation.clearDeviceMetricsOverride');
        await page.goto(startUrl);
        await injectJQuery(page);
        await page.type('#searchboxinput', searchString);
        await sleep(5000);
        await page.click('#searchbox-searchbutton');
        await sleep(5000);
        await waitForGoogleMapLoader(page);
        // In case there is no listing, put just detail page to queue
        const maybeDetailPlace = await page.$('h1.section-hero-header-title');
        if (maybeDetailPlace) {
            const url = page.url();
            await requestQueue.addRequest({ url, userData: { label: 'detail' } });
            return;
        }
        const nextButtonSelector = '#section-pagination-button-next';
        while (true) {
            await page.waitForSelector(nextButtonSelector, { timeout: DEFAULT_TIMEOUT });
            const paginationText = await page.$eval('.section-pagination-right', (el) => el.innerText);
            const [fromString, toString] = paginationText.match(/\d+/g);
            const from = parseInt(fromString);
            const to = parseInt(toString);
            if (listingPagination.from && from <= listingPagination.from) {
                console.log(`Skiped pagination ${from} - ${to}, already done!`);
            } else {
                console.log(`Added links from pagination ${from} - ${to}`);
                await enqueueAllUrlsFromPagination(page, requestQueue);
                listingPagination = { from, to };
                await Apify.setValue(LISTING_PAGINATION_KEY, listingPagination);
            }
            await page.waitForSelector(nextButtonSelector, { timeout: DEFAULT_TIMEOUT });
            const isNextPaginationDisabled = await page.evaluate((nextButtonSelector) => {
                return !!$(nextButtonSelector).attr('disabled');
            }, nextButtonSelector);
            const noResultsEl = await page.$('.section-no-result-title');
            if (isNextPaginationDisabled || noResultsEl) {
                break;
            } else {
                // NOTE: puppeteer API click() didn't work :(
                await page.evaluate((sel) => $(sel).click(), nextButtonSelector);
                await waitForGoogleMapLoader(page);
            }
        }
    } catch (err) {
        if (retries < MAX_PAGE_RETRIES) {
            ++retries;
            console.log(`Retiring enqueueAllPlaceDetails for ${retries} time, error:`);
            console.error(err);
            await browser.close();
            await enqueueAllPlaceDetailsCrawler(startUrl, searchString, launchPuppeteerOptions, requestQueue, listingPagination, ++retries);
        }
        throw err;
    } finally {
        if (browser) await browser.close();
    }
};

module.exports = { run: enqueueAllPlaceDetailsCrawler };
