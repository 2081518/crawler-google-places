const Apify = require('apify');

const { sleep, log } = Apify.utils;
const infiniteScroll = require('./infinite_scroll');

const { injectJQuery } = Apify.utils.puppeteer;
const { MAX_PAGE_RETRIES, DEFAULT_TIMEOUT, LISTING_PAGINATION_KEY } = require('./consts');
const enqueueAllPlaceDetailsCrawler = require('./enqueue_places_crawler');
/**
 * Method to set up crawler to get all place details and save them to default dataset
 * @param launchPuppeteerOptions
 * @param requestQueue
 * @param maxCrawledPlaces
 * @return {Apify.PuppeteerCrawler}
 */
const setUpCrawler = (launchPuppeteerOptions, requestQueue, maxCrawledPlaces) => {
    const crawlerOpts = {
        launchPuppeteerOptions,
        requestQueue,
        maxRequestRetries: MAX_PAGE_RETRIES,
        retireInstanceAfterRequestCount: 10,
        handlePageTimeoutSecs: 2 * 3600, // Two hours because startUrl crawler
        maxOpenPagesPerInstance: 1, // Because startUrl crawler crashes if we mixed tabs with details scraping
        // maxConcurrency: 1,
    };
    if (maxCrawledPlaces) {
        crawlerOpts.maxRequestsPerCrawl = maxCrawledPlaces + 1; // The first one is startUrl
    }
    return new Apify.PuppeteerCrawler({
        ...crawlerOpts,
        gotoFunction: async ({ request, page }) => {
            await page._client.send('Emulation.clearDeviceMetricsOverride');
            await page.goto(request.url, { timeout: 60000 });
        },
        handlePageFunction: async ({ request, page }) => {
            const { label, searchString } = request.userData;
            log.info(`Open ${request.url} with label: ${label}`);
            await injectJQuery(page);
            if (label === 'startUrl') {
                // enqueue all places
                log.info(`Start enqueuing place details for search: ${searchString}`);
                // Store state of listing pagination
                // NOTE: Ensured - If pageFunction failed crawler skipped already scraped pagination
                const listingPagination = await Apify.getValue(LISTING_PAGINATION_KEY) || {};
                await enqueueAllPlaceDetailsCrawler.run(page, searchString, launchPuppeteerOptions, requestQueue, listingPagination, maxCrawledPlaces);
                listingPagination.isFinish = true;
                await Apify.setValue(LISTING_PAGINATION_KEY, listingPagination);
            } else {
                // Timeout because timeout for handle page is 2 hours
                setTimeout(() => {
                    throw new Error('HandlePagefunction timed out!');
                }, 600000);
                // Get data from review
                const titleSel = 'h1.section-hero-header-title';
                await page.waitForSelector(titleSel, { timeout: DEFAULT_TIMEOUT });
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
                const histogramSel = '.section-popular-times';
                if (await page.$(histogramSel)) {
                    placeDetail.popularTimesHistogram = await page.evaluate(() => {
                        const graphs = {};
                        const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
                        // Days graphs
                        $('.section-popular-times-graph').each(function(i) {
                            const day = days[i];
                            graphs[day] = [];
                            let graphStartFromHour;
                            $(this).find('.section-popular-times-label').each(function(labelIndex) {
                                if (graphStartFromHour) return;
                                const hourText = $(this).text().trim();
                                graphStartFromHour = hourText.includes('p')
                                    ? 12 + (parseInt(hourText) - labelIndex)
                                    : parseInt(hourText) - labelIndex;
                            });
                            $(this).find('.section-popular-times-bar').each(function (barIndex) {
                                const occupancy = $(this).attr('aria-label').match(/\d+\s{1,}%/)[0];
                                const maybeHour = graphStartFromHour + barIndex;
                                graphs[day].push({
                                    hour: maybeHour > 24 ? maybeHour - 24 : maybeHour,
                                    occupancy,
                                });
                            });
                        });
                        return graphs;
                    });
                }
                placeDetail.reviews = [];
                const reviewsButtonSel = 'button[jsaction="pane.reviewChart.moreReviews"]';
                if (placeDetail.totalScore) {
                    placeDetail.reviewsCount = await page.evaluate((selector) => {
                        const numberReviewsText = $(selector).text().trim();
                        return (numberReviewsText) ? numberReviewsText.match(/\d+/)[0] : null;
                    }, reviewsButtonSel);
                    // If we find consent dialog, close it!
                    if (await page.$('.widget-consent-dialog')) {
                        await page.click('.widget-consent-dialog .widget-consent-button-later');
                    }
                    // Get all reviews
                    await page.waitForSelector(reviewsButtonSel);
                    await page.click(reviewsButtonSel);
                    await page.waitForSelector('.section-star-display', { timeout: DEFAULT_TIMEOUT });
                    await sleep(5000);
                    // Sort reviews by newest, one click sometimes didn't work :)
                    try {
                        const sortButtonEl = '.section-tab-info-stats-button-flex';
                        await page.click(sortButtonEl);
                        await sleep(1000);
                        await page.click(sortButtonEl);
                        await sleep(1000);
                        await page.click(sortButtonEl);
                        await sleep(5000);
                        await page.click('.context-menu-entry[data-index="1"]');
                    } catch (err) {
                        // It can happen, it is not big issue :)
                        log.debug('Cannot select reviews by newest!');
                    }
                    await infiniteScroll(page, 99999999999, '.section-scrollbox.section-listbox');
                    const reviewEls = await page.$$('div.section-review');
                    for (const reviewEl of reviewEls) {
                        const moreButton = await reviewEl.$('.section-expand-review');
                        if (moreButton) {
                            await moreButton.click();
                            await sleep(2000);
                        }
                        const review = await page.evaluate((reviewEl) => {
                            const $review = $(reviewEl);
                            const reviewData = {
                                name: $review.find('.section-review-title').text().trim(),
                                text: $review.find('.section-review-review-content .section-review-text').text(),
                                stars: $review.find('.section-review-stars').attr('aria-label').trim(),
                                publishAt: $review.find('.section-review-publish-date').text().trim(),
                                likesCount: $review.find('.section-review-thumbs-up-count').text().trim(),
                            };
                            const $response = $review.find('.section-review-owner-response');
                            if ($response) {
                                reviewData.responseFromOwnerText = $response.find('.section-review-text').text().trim();
                            }
                            return reviewData;
                        }, reviewEl);
                        placeDetail.reviews.push(review);
                    }
                    await page.click('button.section-header-back-button');
                }
                await page.waitForSelector(titleSel, { timeout: DEFAULT_TIMEOUT });
                const imagesButtonSel = '[jsaction="pane.imagepack.button"]';
                console.log(imagesButtonSel);
                if (await page.$(imagesButtonSel)) {
                    await page.click(imagesButtonSel);
                    await infiniteScroll(page, 99999999999, '.section-scrollbox.section-listbox');
                    placeDetail.imageUrls = await page.evaluate(() => {
                        const urls = [];
                        $('.gallery-image-high-res').each(function () {
                            const urlMatch = $(this).attr('style').match(/url\("(.*)"\)/);
                            if (!urlMatch) return;
                            let imageUrl = urlMatch[1];
                            if (imageUrl[0] === '/') imageUrl = `https:${imageUrl}`;
                            urls.push(imageUrl);
                        });
                        return urls;
                    });
                }
                await Apify.pushData(placeDetail);
            }
            log.info('Finished', request.url);
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
};

module.exports = { setUpCrawler };
