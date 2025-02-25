import puppeteer, { ScreenshotOptions } from 'puppeteer';
import url from 'url';
import { dirname } from 'path';

import { Config } from './config';

type SerializedResponse = {
  status: number;
  customHeaders: Map<string, string>;
  content: string;
};

type ViewportDimensions = {
  width: number;
  height: number;
};

const MOBILE_USERAGENT =
  'Mozilla/5.0 (Linux; Android 8.0.0; Pixel 2 XL Build/OPD1.170816.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.75 Mobile Safari/537.36';

/**
 * Wraps Puppeteer's interface to Headless Chrome to expose high level rendering
 * APIs that are able to handle web components and PWAs.
 */
export class Renderer {
  private browser: puppeteer.Browser;
  private config: Config;
  private static magentoTags: {[key: string]: string} = {}
  // private static redirects: {[key: string]: object} = {}

  constructor(browser: puppeteer.Browser, config: Config) {
    this.browser = browser;
    this.config = config;
  }

  private restrictRequest(requestUrl: string): boolean {
    const parsedUrl = url.parse(requestUrl);

    if (parsedUrl.hostname && parsedUrl.hostname.match(/\.internal$/)) {
      return true;
    }

    if (this.config.restrictedUrlPattern && requestUrl.match(new RegExp(this.config.restrictedUrlPattern))) {
      return true;
    }

    return false;
  }

  async serialize(
    requestUrl: string,
    isMobile: boolean,
    timezoneId?: string
  ): Promise<SerializedResponse> {

    /**
     * Executed on the page after the page has loaded. Strips script and
     * import tags to prevent further loading of resources.
     */
    function stripPage(stripSelectors: string) {
      if (stripSelectors) {
        // Strip only script tags that contain JavaScript (either no type attribute or one that contains "javascript")
        const elements = document.querySelectorAll(
            stripSelectors
        );
        for (const e of Array.from(elements)) {
          e.remove();
        }
      }
    }

    /**
     * Injects a <base> tag which allows other resources to load. This
     * has no effect on serialised output, but allows it to verify render
     * quality.
     */
    function injectBaseHref(origin: string, directory: string) {
      const bases = document.head.querySelectorAll('base');
      if (bases.length) {
        // Patch existing <base> if it is relative.
        const existingBase = bases[0].getAttribute('href') || '';
        if (existingBase.startsWith('/')) {
          // check if is only "/" if so add the origin only
          if (existingBase === '/') {
            bases[0].setAttribute('href', origin);
          } else {
            bases[0].setAttribute('href', origin + existingBase);
          }
        }
      } else {
        // Only inject <base> if it doesn't already exist.
        const base = document.createElement('base');
        // Base url is the current directory
        base.setAttribute('href', origin + directory);
        document.head.insertAdjacentElement('afterbegin', base);
      }
    }

    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport({
      width: isMobile ? this.config.widthMobile : this.config.width,
      height: isMobile ? this.config.heightMobile : this.config.height,
      isMobile,
    });

    if (isMobile && this.config.setUserAgentMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    if (timezoneId) {
      try {
        await page.emulateTimezone(timezoneId);
      } catch (e) {
        if (e.message.includes('Invalid timezone')) {
          return {
            status: 400,
            customHeaders: new Map(),
            content: 'Invalid timezone id',
          };
        }
      }
    }

    await page.setExtraHTTPHeaders(this.config.reqHeaders);

    page.evaluateOnNewDocument('customElements.forcePolyfill = true');
    page.evaluateOnNewDocument('ShadyDOM = {force: true}');
    page.evaluateOnNewDocument('ShadyCSS = {shimcssproperties: true}');

    await page.setRequestInterception(true);

    page.on('request', (interceptedRequest: puppeteer.Request) => {
      if (this.restrictRequest(interceptedRequest.url())) {
        interceptedRequest.abort();
      } else {
        // graphql post requests are not allowed - only the urlResolver is allowed
        // this will make sure requests like the createCart mutation are blocked
        if (interceptedRequest.method() === 'POST' && interceptedRequest.url() && !interceptedRequest.postData()?.match(new RegExp('urlResolver'))) {
          interceptedRequest.abort();
        } else {
          interceptedRequest.continue();
        }
      }
    });

    let response: puppeteer.Response | null = null;
    // Capture main frame response. This is used in the case that rendering
    // times out, which results in puppeteer throwing an error. This allows us
    // to return a partial response for what was able to be rendered in that
    // time frame.

    page.on('response', (r: puppeteer.Response) => {
      if (r.request().method() == 'GET' ) {
        if (requestUrl.endsWith('/')) {
          requestUrl = requestUrl.substring(0, requestUrl.length - 1);
        }

        let saveKey = requestUrl;
        if (isMobile) {
          saveKey = "_" + saveKey;
        }

        if (!Renderer.magentoTags[saveKey]) {
          Renderer.magentoTags[saveKey] = '';
        }

        if (r.headers()['x-magento-tags']) {
          console.log("add keys for url: " + saveKey);

          Renderer.magentoTags[saveKey] += ' ' + r.headers()['x-magento-tags'];
        }

        if (r.headers().xkey != undefined && r.headers().xkey != '') {
          console.log("add keys for url: " + saveKey);

          Renderer.magentoTags[saveKey] += ' ' + r.headers().xkey;
        }
      }

      if (!response) {
        response = r;
      }
    });

    try {
      // Navigate to page. Wait until there are no oustanding network requests.
      response = await page.goto(requestUrl, {
        // default minimum timeout should be 300000 because we have a timeout of 60000 for 5 selectors
        timeout: this.config.timeout > 10000 ? this.config.timeout : 10000,
        waitUntil: 'domcontentloaded',
      });
      await page.setDefaultTimeout(10000);
      const selector = this.config.querySelectorAll ?
          this.config.querySelectorAll :`
            main > [class*="-bannerImage-"],
            main > [class*="main-page-"],
            main > [class*="-RootComponents-"],
            [class*="-breadcrumbs-"],
            main > [class*="-errorView-"],
            main > [class*="-layoutContainer-"],
            main > [class*="-ProductFullDetail-"],
            main > [class*="-productFullDetail-"] form,
            main > div > [class*="-components-base-grid-"],
            main > div > [class*="-contentBlocks-"],
            main > div > [class*="-summaryFinder-"],
            main > h1,
            main > form
        `;

        await page.waitForFunction((selector: string) =>
        document.querySelectorAll(`${selector}`).length
      , {}, selector);
        await page.waitForSelector('[class*="_pending-"]', { hidden: true});

        if (await page.$('[class*="-breadcrumbs-"]') !== null) {
        await page.waitForFunction(() =>
          document.querySelectorAll(`
              [class*="-breadcrumbs-breadcrumbs__link-"],
              [class*="emptyBreadCrumbs"]
          `).length
        );
      }
      if (await page.$('main > [class*="-errorView-"]') !== null) {
        throw new Error('Don\'t cache "This is a 404 Page which should not be cached."')
      }

        await page.waitForFunction(() =>
            !document.title.includes('Home Page') &&
            !document.title.includes('undefined')
        );

    } catch (e) {
      console.error(e);
      if (e.name == 'TimeoutError') {
        await page.close();
        if (this.config.closeBrowser) {
          await this.browser.close();
        }
        const timeoutHeaders = new Map();
        timeoutHeaders.set('Connection', 'close')
        return { status: 408, customHeaders: timeoutHeaders, content: 'Timeout: The page that should be rendered is to slow!' };
      }
    }

    if (!response) {
      console.error('response does not exist');
      // This should only occur when the page is about:blank. See
      // https://github.com/GoogleChrome/puppeteer/blob/v1.5.0/docs/api.md#pagegotourl-options.
      await page.close();
      if (this.config.closeBrowser) {
        await this.browser.close();
      }
      return { status: 400, customHeaders: new Map(), content: '' };
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response.headers()['metadata-flavor'] === 'Google') {
      await page.close();
      if (this.config.closeBrowser) {
        await this.browser.close();
      }
      return { status: 403, customHeaders: new Map(), content: '' };
    }

    // Set status to the initial server's response code. Check for a <meta
    // name="render:status_code" content="4xx" /> tag which overrides the status
    // code.
    let statusCode = response.status();
    const newStatusCode = await page
      .$eval('meta[name="render:status_code"]', (element) =>
        parseInt(element.getAttribute('content') || '')
      )
      .catch(() => undefined);
    // On a repeat visit to the same origin, browser cache is enabled, so we may
    // encounter a 304 Not Modified. Instead we'll treat this as a 200 OK.
    if (statusCode === 304) {
      statusCode = 200;
    }
    // Original status codes which aren't 200 always return with that status
    // code, regardless of meta tags.
    if (statusCode === 200 && newStatusCode) {
      statusCode = newStatusCode;
    }

    // Check for <meta name="render:header" content="key:value" /> tag to allow a custom header in the response
    // to the crawlers.
    const customHeaders = await page
      .$eval('meta[name="render:header"]', (element) => {
        const result = new Map<string, string>();
        const header = element.getAttribute('content');
        if (header) {
          const i = header.indexOf(':');
          if (i !== -1) {
            result.set(
              header.substr(0, i).trim(),
              header.substring(i + 1).trim()
            );
          }
        }
        return JSON.stringify([...result]);
      })
      .catch(() => undefined);

    // Remove script & import tags.
    await page.evaluate(stripPage, this.config.stripSelectors);
    // Inject <base> tag with the origin of the request (ie. no path).
    const parsedUrl = url.parse(requestUrl);
    await page.evaluate(
      injectBaseHref,
      `${parsedUrl.protocol}//${parsedUrl.host}`,
      `${dirname(parsedUrl.pathname || '')}`
    );

    // Serialize page.
    const result = (await page.content()) as string;

    await page.close();
    if (this.config.closeBrowser) {
      await this.browser.close();
    }
    return {
      status: statusCode,
      customHeaders: customHeaders
        ? new Map(JSON.parse(customHeaders))
        : new Map(),
      content: result,
    };
  }

  static getMagentoTags(url: string): string
  {
    // TODO fix this in a nice way?

    if (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }

    console.log('Get magentoTags for: ' + url);
    console.log('Get magentoTags for: ' + url);

    if (Renderer.magentoTags[url]) {
      // Remove duplicate tags
      const tags = Renderer.magentoTags[url]
      const unique = Array.from(new Set(tags.split(' ')));

      console.log('magentoTags: ' + Renderer.magentoTags[url].length);
      console.log('new magentoTags: ' + unique.join(' ').length);

      return unique.join(' ');
    }

    console.log('magentoTags: -1');

    return '';
  }

  static setMagentoTags(magentoTag: string, url: string): void
  {
    if (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }

    if (Renderer.magentoTags[url]) {
      Renderer.magentoTags[url] = magentoTag;
    }
  }

  static unsetMagentoTags(url: string): void
  {
    if (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }

    if (Renderer.magentoTags[url]) {
      delete Renderer.magentoTags[url];
    }
  }

  async screenshot(
    url: string,
    isMobile: boolean,
    dimensions: ViewportDimensions,
    options?: ScreenshotOptions,
    timezoneId?: string
  ): Promise<Buffer> {
    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport({
      width: dimensions.width,
      height: dimensions.height,
      isMobile,
    });

    if (isMobile && this.config.setUserAgentMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    await page.setRequestInterception(true);

    page.addListener('request', (interceptedRequest: puppeteer.Request) => {
      if (this.restrictRequest(interceptedRequest.url())) {
        interceptedRequest.abort();
      } else {
        interceptedRequest.continue();
      }
    });

    if (timezoneId) {
      await page.emulateTimezone(timezoneId);
    }

    let response: puppeteer.Response | null = null;

    try {
      // Navigate to page. Wait until there are no oustanding network requests.
      response = await page.goto(url, {
        timeout: this.config.timeout,
        waitUntil: 'networkidle0',
      });
    } catch (e) {
      console.error(e);
    }

    if (!response) {
      await page.close();
      if (this.config.closeBrowser) {
        await this.browser.close();
      }
      throw new ScreenshotError('NoResponse');
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response.headers()['metadata-flavor'] === 'Google') {
      await page.close();
      if (this.config.closeBrowser) {
        await this.browser.close();
      }
      throw new ScreenshotError('Forbidden');
    }

    // Must be jpeg & binary format.
    const screenshotOptions: ScreenshotOptions = {
      type: options?.type || 'jpeg',
      encoding: options?.encoding || 'binary',
    };
    // Screenshot returns a buffer based on specified encoding above.
    // https://github.com/GoogleChrome/puppeteer/blob/v1.8.0/docs/api.md#pagescreenshotoptions
    const buffer = (await page.screenshot(screenshotOptions)) as Buffer;
    await page.close();
    if (this.config.closeBrowser) {
      await this.browser.close();
    }
    return buffer;
  }
}

type ErrorType = 'Forbidden' | 'NoResponse';

export class ScreenshotError extends Error {
  type: ErrorType;

  constructor(type: ErrorType) {
    super(type);

    this.name = this.constructor.name;

    this.type = type;
  }
}
