/**
 * Run the following example to perform a recursive crawl of a website using Puppeteer.
 */
const Apify = require('apify');
const infiniteScroll = require('./infinite_scroll');

const { sleep } = Apify.utils;
const { injectJQuery } = Apify.utils.puppeteer;

// NOTE: This is not nice, it waits for implementing default timeout into puppeteer.
const DEFAULT_TIMEOUT = 60 * 1000; // 60 sec

const LISTING_PAGINATION_KEY = 'listingState';
const MAX_PAGE_RETRIES = 5;

const waitForGoogleMapLoader = (page) => page.waitFor(() => !document.querySelector('#searchbox').classList.contains('loading'), { timeout: DEFAULT_TIMEOUT });

const enqueueAllUrlsFromPagination = async (page, requestQueue) => {
    const detailLinks = [];
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
    return detailLinks;
};

const enqueueAllPlaceDetails = async (startUrl, searchString, launchPuppeteerOptions, requestQueue, listingPagination, retries = 0) => {
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
            if (isNextPaginationDisabled) {
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
            console.log(`Retiring enqueueAllPlaceDetails for ${retries} time.`);
            await browser.close();
            await enqueueAllPlaceDetails(startUrl, searchString, launchPuppeteerOptions, requestQueue, listingPagination, ++retries);
        }
        throw err;
    } finally {
        if (browser) await browser.close();
    }
};

Apify.main(async () => {
    const input = await Apify.getValue('INPUT');
    const { searchString, proxyConfig, lat, lng } = input;

    if (!searchString) throw new Error('Attribute searchString missing in input.');

    console.log('Scraping Google Places for search string:', searchString);

    let startUrl;
    if (lat || lng) {
        const { zoom = 10 } = input;
        if (!lat || !lng) throw new Error('You have to defined lat and lng!');
        startUrl = `https://www.google.com/maps/@${lat},${lng},${zoom}z/search`;
    } else {
        startUrl = 'https://www.google.com/maps/search/';
    }

    console.log('Start url is', startUrl);

    const requestQueue = await Apify.openRequestQueue();

    // Store state of listing pagination
    // NOTE: Ensured - If pageFunction failed crawler skipped already scraped pagination
    const listingPagination = await Apify.getValue(LISTING_PAGINATION_KEY) || {};

    const launchPuppeteerOptions = {
        // useApifyProxy: true,
        // useChrome: true,
        // apifyProxyGroups: ['CZECH_LUMINATI'],
        // liveView: Apify.isAtHome(),
    };
    if (proxyConfig) Object.assign(launchPuppeteerOptions, proxyConfig);

    // Enqueue all links to scrape from listings
    if (!listingPagination.isFinish) {
        console.log(`Start enqueuing place details for search: ${searchString}`);
        await enqueueAllPlaceDetails(startUrl, searchString, launchPuppeteerOptions, requestQueue, listingPagination);
        listingPagination.isFinish = true;
        await Apify.setValue(LISTING_PAGINATION_KEY, listingPagination);
    }

    // Scrape all place detail links
    const crawler = new Apify.PuppeteerCrawler({
        launchPuppeteerOptions,
        requestQueue,
        maxRequestRetries: MAX_PAGE_RETRIES,
        retireInstanceAfterRequestCount: 10,
        handlePageTimeoutSecs: 600,
        handlePageFunction: async ({ request, page }) => {
            const { label } = request.userData;
            console.log(`Open ${request.url} with label: ${label}`);
            // Get data from review
            await page._client.send('Emulation.clearDeviceMetricsOverride');
            await injectJQuery(page);
            await page.waitForSelector('h1.section-hero-header-title', { timeout: DEFAULT_TIMEOUT });
            const placeDetail = await page.evaluate(() => {
                return {
                    title: $('h1.section-hero-header-title').text().trim(),
                    totalScore: $('span.section-star-display').eq(0).text().trim(),
                    categoryName: $('[jsaction="pane.rating.category"]').text().trim(),
                    address: $('[data-section-id="ad"] .widget-pane-link').text().trim(),
                    plusCode: $('[data-section-id="ol"] .widget-pane-link').text().trim(),
                };
            });
            placeDetail.url = request.url;
            placeDetail.reviews = [];
            if (placeDetail.totalScore) {
                placeDetail.reviewsCount = await page.evaluate(() => {
                    const numberReviewsText = $('button.section-reviewchart-numreviews').text().trim();
                    return (numberReviewsText) ? numberReviewsText.match(/\d+/)[0] : null;
                });
                // Get all reviews
                await page.click('button.section-reviewchart-numreviews');
                await page.waitForSelector('.section-star-display', { timeout: DEFAULT_TIMEOUT });
                await infiniteScroll(page, 99999999999, '.section-scrollbox');
                sleep(2000);
                const reviewEls = await page.$$('div.section-review');
                for (const reviewEl of reviewEls) {
                    const moreButton = await reviewEl.$('.section-expand-review');
                    if (moreButton) {
                        await moreButton.click();
                        sleep(1000);
                    }
                    const review = await page.evaluate((reviewEl) => {
                        const $review = $(reviewEl);
                        return {
                            name: $review.find('.section-review-title').text().trim(),
                            text: $review.find('.section-review-text').text(),
                            stars: $review.find('.section-review-stars').attr('aria-label').trim(),
                            publishAt: $review.find('.section-review-publish-date').text().trim(),
                            likesCount: $review.find('.section-review-thumbs-up-count').text().trim(),
                        };
                    }, reviewEl);
                    placeDetail.reviews.push(review);
                }
            }
            await Apify.pushData(placeDetail);

            console.log(request.url, 'Done');
        },
        handleFailedRequestFunction: async ({ request }) => {
            // This function is called when crawling of a request failed too many time
            await Apify.pushData({
                url: request.url,
                succeeded: false,
                errors: request.errorMessages,
            });
        },
    });

    await crawler.run();
});
