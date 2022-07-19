/*
 * Copyright 2020 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may
 not
 * use this file except in compliance with the License. You may obtain a copy
 of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 under
 * the License.
 */

'use strict';

import {createHash} from "crypto";

import {Config} from "../config";
import * as Koa from "koa";
import fs from "fs";
import path from "path";
import {Renderer} from "../renderer";

type CacheContent = {
    saved: Date;
    expires: Date;
    response: string;
    payload: string;
};

export class FilesystemTagsCache {
    private config: Config;
    private cacheConfig: { [key: string]: string };

    constructor(config: Config) {
        console.log("Filesystem Tags Cache middeleware constructor");

        this.config = config;
        this.cacheConfig = this.config.cacheConfig;
    }

    hashCode = (s: string) => {
        const hash = 0;
        if (s.length === 0) return hash.toString();

        console.log("hash code render Tags <------")
        console.log(s)

        return createHash('md5').update(s).digest('hex');
    };

    invalidateHandler() {
        return this.handleInvalidateRequest.bind(this);
    }

    sanitizeKey(key: string) {
        // Cache based on full URL. This means requests with different params are
        // cached separately (except for refreshCache parameter
        let cacheKey = key.replace(/&?refreshCache=(?:true|false)&?/i, '');

        if (cacheKey.charAt(cacheKey.length - 1) === '?') {
            cacheKey = cacheKey.slice(0, -1);
        }

        // remove /seo-snap/ from key, only at the start
        if (cacheKey.startsWith('/seo-snap/')) {
            cacheKey = cacheKey.substring(10);
        }

        // remove /seo-snap/ from key, only at the start
        if (cacheKey.startsWith('/render/')) {
            cacheKey = cacheKey.substring(8);
        }

        // remove trailing slash from key
        cacheKey = cacheKey.replace(/\/$/, '');
        return cacheKey
    }

    private async handleInvalidateRequest(ctx: Koa.Context, url: string) {
        let cacheKey = this.sanitizeKey(url);

        // remove /invalidate/ from key, only at the start
        if (cacheKey.startsWith('/invalidate/')) {
            cacheKey = cacheKey.substring(12);
        }

        // key is hashed crudely
        const key = this.hashCode(cacheKey);
        this.clearCache(key);
        ctx.status = 200;
    }

    async clearCache(key: string) {
        let cleanKey = key;
        if (!cleanKey.endsWith('.json')) {
            cleanKey += '.json';
        }
        if (fs.existsSync(path.join(this.getDir(''), cleanKey))) {
            try {
                fs.unlinkSync(path.join(this.getDir(''), cleanKey));
                console.log(`deleting: ${path.join(this.getDir(''), cleanKey)}`);
            } catch (err) {
                console.log(err);
            }
        }
    }

    getDir = (key: string) => {
        const dir = this.cacheConfig.snapshotDir;

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (key) {
            return path.join(dir, key);
        }

        return dir;
    };

    clearAllCacheHandler() {
        return this.handleClearAllCacheRequest.bind(this);
    }

    private async handleClearAllCacheRequest(ctx: Koa.Context) {
        await this.clearAllCache();
        ctx.status = 200;
    }

    async clearAllCache() {
        return new Promise((resolve) => {
            fs.readdir(this.getDir(''), (err, files) => {
                if (err) throw err;
                for (const file of files) {
                    fs.unlink(path.join(this.getDir(''), file), (err) => {
                        if (err) throw err;
                    });
                }
                resolve();
            });
        });
    }

    getCachedContent(ctx: Koa.Context, key: string): CacheContent | null {
        if (ctx.query.refreshCache) {
            return null;
        } else {
            try {
                const cacheFile = JSON.parse(
                    fs.readFileSync(path.join(this.getDir(''), key + '.json'), 'utf8')
                );
                const payload = cacheFile.responseBody;
                const response = JSON.stringify(cacheFile.responseHeaders);
                if (!payload) {
                    return null;
                }
                const fd = fs.openSync(path.join(this.getDir(''), key + '.json'), 'r');
                const stats = fs.fstatSync(fd);
                // use modification time as the saved time
                const saved = stats.mtime;
                const expires = new Date(
                    saved.getTime() +
                    parseInt(this.cacheConfig.cacheDurationMinutes) * 60 * 1000
                );
                return {
                    saved,
                    expires,
                    payload,
                    response,
                };
            } catch (err) {
                return null;
            }
        }
    }

    private sortFilesByModDate(numCache: string[]) {
        const dirsDate = [];
        for (let i = 0; i < numCache.length; i++) {
            if (fs.existsSync(path.join(this.getDir(''), numCache[i]))) {
                const stats = fs.statSync(path.join(this.getDir(''), numCache[i]));
                const mtime = stats.mtime;
                dirsDate.push({ fileName: numCache[i], age: mtime.getTime() });
            }
        }
        dirsDate.sort((a, b) => (a.age > b.age ? 1 : -1));
        return dirsDate;
    }

    cacheContent(key: string, ctx: Koa.Context) {
        const responseHeaders = ctx.response;
        const responseBody = ctx.body;
        const request = ctx.request;

        // check size of stored cache to see if we are over the max number of allowed entries, and max entries isn't disabled with a value of -1 and remove over quota, removes oldest first
        if (parseInt(this.config.cacheConfig.cacheMaxEntries) !== -1) {
            const numCache = fs.readdirSync(this.getDir(''));
            if (
                numCache.length >= parseInt(this.config.cacheConfig.cacheMaxEntries)
            ) {
                const toRemove =
                    numCache.length -
                    parseInt(this.config.cacheConfig.cacheMaxEntries) +
                    1;
                let dirsDate = this.sortFilesByModDate(numCache);
                dirsDate = dirsDate.slice(0, toRemove);
                dirsDate.forEach((rmDir) => {
                    if (rmDir.fileName !== key + '.json') {
                        console.log(
                            `max cache entries reached - removing: ${rmDir.fileName}`
                        );
                        this.clearCache(rmDir.fileName);
                    }
                });
            }
        }

        fs.writeFileSync(
            path.join(this.getDir(''), key + '.json'),
            JSON.stringify({ responseBody, responseHeaders, request })
        );
    }

    middleware() {
        const cacheContent = this.cacheContent.bind(this);

        return async function (
            this: FilesystemTagsCache,
            ctx: Koa.Context,
            next: () => Promise<unknown>
        ) {
            const cacheKey = this.sanitizeKey(ctx.url);
            const key = this.hashCode(cacheKey);
            const content = await this.getCachedContent(ctx, key);

            if (content) {
                // Serve cached content if its not expired.
                if (
                    content.expires.getTime() >= new Date().getTime() ||
                    parseInt(this.config.cacheConfig.cacheDurationMinutes) === -1
                ) {
                    const response = JSON.parse(content.response);
                    ctx.set(response.header);
                    ctx.set('x-rendertron-cached', content.saved.toUTCString());
                    ctx.status = response.status;
                    let payload: string | { type?: string } = content.payload;
                    try {
                        payload = JSON.parse(content.payload);
                    } catch (e) {
                        // swallow this.
                    }
                    try {
                        if (
                            payload &&
                            typeof payload === 'object' &&
                            payload.type === 'Buffer'
                        ) {
                            ctx.body = Buffer.from(payload as any);
                        } else {
                            ctx.body = payload;
                        }
                        return;
                    } catch (error) {
                        console.log(
                            'Erroring parsing cache contents, falling back to normal render'
                        );
                    }
                }
            }

            await next();

            if (ctx.status === 200) {
                cacheContent(key, ctx);

                let url: string = this.sanitizeKey(ctx.url);
                url = url.split('?')[0]
                url = url.replace('%3F', '?');
                url = url.replace('%3D', '=');

                if (ctx.query.mobile) {
                    url = "_" + url;
                }

                if (ctx.query.refreshCache) {
                    ctx.body = {
                        html: ctx.body,
                        tags: ' ' + Renderer.getMagentoTags(url) + ' ',
                    };
                }

                Renderer.unsetMagentoTags(url)
            } else if ((ctx.status === 404 || ctx.status === 500) && this.config.healthCheckKey) {
                let https = require('https');
                https.get('https://hc-ping.com/' + this.config.healthCheckKey + '/fail');

            }
        }.bind(this);
    }
}
