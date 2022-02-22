import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import koaCompress from 'koa-compress';
import route from 'koa-route';
import koaSend from 'koa-send';
import koaLogger from 'koa-logger';
import path from 'path';
import puppeteer from 'puppeteer';
import url from 'url';

import { Renderer, ScreenshotError } from './renderer';
import { Config, ConfigManager } from './config';

/**
 * Rendertron rendering service. This runs the server which routes rendering
 * requests through to the renderer.
 */
export class Rendertron {
  app: Koa = new Koa();
  private config: Config = ConfigManager.config;
  private renderer: Renderer | undefined;
  private port = process.env.PORT || null;
  private host = process.env.HOST || null;

  async createRenderer(config: Config) {
    const browser = await puppeteer.launch({ args: config.puppeteerArgs });

    browser.on('disconnected', () => {
      this.createRenderer(config);
    });

    this.renderer = new Renderer(browser, config);
  }

  async initialize(config?: Config) {
    // Load config
    this.config = config || (await ConfigManager.getConfiguration());

    this.port = this.port || this.config.port;
    this.host = this.host || this.config.host;

    await this.createRenderer(this.config);

    this.app.use(koaLogger());

    this.app.use(koaCompress());

    this.app.use(bodyParser());

    this.app.use(
      route.get('/', async (ctx: Koa.Context) => {
        await koaSend(ctx, 'index.html', {
          root: path.resolve(__dirname, '../src'),
        });
      })
    );
    this.app.use(
      route.get('/_ah/health', (ctx: Koa.Context) => (ctx.body = 'OK'))
    );

    // Optionally enable cache for rendering requests.
    if (this.config.cache === 'datastore') {
      const { DatastoreCache } = await import('./cache/datastore-cache');
      const datastoreCache = new DatastoreCache();
      this.app.use(
        route.get('/invalidate/:url(.*)', datastoreCache.invalidateHandler())
      );
      this.app.use(
        route.get('/invalidate/', datastoreCache.clearAllCacheHandler())
      );
      // this.app.use(datastoreCache.middleware());
    } else if (this.config.cache === 'memory') {
      const { MemoryCache } = await import('./cache/memory-cache');
      const memoryCache = new MemoryCache();
      this.app.use(
        route.get('/invalidate/:url(.*)', memoryCache.invalidateHandler())
      );
      this.app.use(
        route.get('/invalidate/', memoryCache.clearAllCacheHandler())
      );
      // this.app.use(memoryCache.middleware());
    } else if (this.config.cache === 'filesystem') {
      const { FilesystemCache } = await import('./cache/filesystem-cache');
      const filesystemCache = new FilesystemCache(this.config);
      this.app.use(
        route.get('/invalidate/:url(.*)', filesystemCache.invalidateHandler())
      );
      this.app.use(
        route.get('/invalidate/', filesystemCache.clearAllCacheHandler())
      );
      // this.app.use(new FilesystemCache(this.config).middleware());
    } else if (this.config.cache === 'filesystem-tags') {
      const { FilesystemTagsCache } = await import('./cache/filesystem-tags-cache');
      const filesystemTagsCache = new FilesystemTagsCache(this.config);

      this.app.use(
          route.get('/invalidate/:url(.*)', filesystemTagsCache.invalidateHandler())
      );

      this.app.use(
          route.get('/invalidate/', filesystemTagsCache.clearAllCacheHandler())
      );
      this.app.use(new FilesystemTagsCache(this.config).middleware());
    }

    this.app.use(
      route.get('/render/:url(.*)', this.handleRenderRequest.bind(this))
    );

    this.app.use(
      route.get('/seo-snap/:url(.*)', this.handleSeoSnapRequest.bind(this))
    );

    this.app.use(
      route.get('/screenshot/:url(.*)', this.handleScreenshotRequest.bind(this))
    );
    this.app.use(
      route.post(
        '/screenshot/:url(.*)',
        this.handleScreenshotRequest.bind(this)
      )
    );

    return this.app.listen(+this.port, this.host, () => {
      console.log(`Listening on port ${this.port}`);
    });
  }

  /**
   * Checks whether or not the URL is valid. For example, we don't want to allow
   * the requester to read the file system via Chrome.
   */
  restricted(href: string): boolean {
    const parsedUrl = url.parse(href);
    const protocol = parsedUrl.protocol || '';

    if (!protocol.match(/^https?/)) {
      return true;
    }

    if (parsedUrl.hostname && parsedUrl.hostname.match(/\.internal$/)) {
      return true;
    }

    if (!this.config.renderOnly.length) {
      return false;
    }

    for (let i = 0; i < this.config.renderOnly.length; i++) {
      if (href.startsWith(this.config.renderOnly[i])) {
        return false;
      }
    }

    return true;
  }




  async handleSeoSnapRequest(ctx: Koa.Context, url: string) {
    console.log('--- start seoSnap ---');
    console.log('url: ' + url);

    if (!this.renderer) {
      throw new Error('No renderer initalized yet.');
    }

    if (this.restricted(url)) {
      ctx.status = 403;
      return;
    }

    const mobileVersion = 'mobile' in ctx.query ? true : false;
    const serialized = await this.renderer.serialize(
        url,
        mobileVersion,
        ctx.query.timezoneId
    );

    for (const key in this.config.headers) {
      ctx.set(key, this.config.headers[key]);
    }

    // Mark the response as coming from Rendertron.
    ctx.set('x-renderer', 'rendertron');
    // Add custom headers to the response like 'Location'
    serialized.customHeaders.forEach((value: string, key: string) =>
        ctx.set(key, value)
    );
    ctx.status = serialized.status;

    ctx.body = serialized.content;
    console.log('--- end seoSnap ---');
  }





  async handleRenderRequest(ctx: Koa.Context, url: string) {
    console.log(' - --- start  handleRenderRequest ----');
    console.log(url);
    console.log('-x-x-x-');

    if (!this.renderer) {
      throw new Error('No renderer initalized yet.');
    }
    // this.renderer.setMagentoTags('');

    if (this.restricted(url)) {
      ctx.status = 403;
      return;
    }

    const mobileVersion = 'mobile' in ctx.query ? true : false;

    const serialized = await this.renderer.serialize(
      url,
      mobileVersion,
      ctx.query.timezoneId
    );

    for (const key in this.config.headers) {
      ctx.set(key, this.config.headers[key]);
    }

    // console.log("x");
    // console.log(this.renderer.getMagentoTags());
    // ctx.cookies.set('xMagentoTags', this.renderer.getMagentoTags(url))

    // Add the magento tags to the response headers.
    // sessionStorage.setItem('key', 'value');
    // window.sessionStorage.setItem('xMagentoTag', this.renderer.getMagentoTags());
    // document.cookie = "xMagentoTags=" + this.renderer.getMagentoTags();

    // ctx.set('x-magento-tags', this.renderer.getMagentoTags(url));

    // Mark the response as coming from Rendertron.
    ctx.set('x-renderer', 'rendertron');

    // Add custom headers to the response like 'Location'
    serialized.customHeaders.forEach((value: string, key: string) =>
      ctx.set(key, value)
    );
    ctx.status = serialized.status;

    // ctx.body = {
    //   'responseBody': serialized.content,
    //   'magentoTags': this.renderer.getMagentoTags(url),
    // };

    ctx.body = serialized.content;

    Renderer.unsetMagentoTags(url);

    console.log(' - --- END handleRenderRequest ----')
  }

  async handleScreenshotRequest(ctx: Koa.Context, url: string) {
    if (!this.renderer) {
      throw new Error('No renderer initalized yet.');
    }

    if (this.restricted(url)) {
      ctx.status = 403;
      return;
    }

    const dimensions = {
      width: Number(ctx.query['width']) || this.config.width,
      height: Number(ctx.query['height']) || this.config.height,
    };

    const mobileVersion = 'mobile' in ctx.query ? true : false;

    try {
      const img = await this.renderer.screenshot(
        url,
        mobileVersion,
        dimensions,
        ctx.query.timezoneId
      );

      for (const key in this.config.headers) {
        ctx.set(key, this.config.headers[key]);
      }

      ctx.set('Content-Type', 'image/jpeg');
      ctx.set('Content-Length', img.length.toString());
      ctx.body = img;
    } catch (error) {
      const err = error as ScreenshotError;
      ctx.status = err.type === 'Forbidden' ? 403 : 500;
    }
  }
}

async function logUncaughtError(error: Error) {
  console.error('Uncaught exception');
  console.error(error);
  process.exit(1);
}

// The type for the unhandleRejection handler is set to contain Promise<any>,
// so we disable that linter rule for the next line
// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
async function logUnhandledRejection(reason: unknown, _: Promise<any>) {
  console.error('Unhandled rejection');
  console.error(reason);
  process.exit(1);
}

// Start rendertron if not running inside tests.
if (!module.parent) {
  const rendertron = new Rendertron();
  rendertron.initialize();

  process.on('uncaughtException', logUncaughtError);
  process.on('unhandledRejection', logUnhandledRejection);
}
