/*
 * Copyright 2018 Google Inc. All rights reserved.
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

import * as fse from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

const CONFIG_PATH = path.resolve(__dirname, '../config.json');

export type Config = {
  cache: 'datastore' | 'memory' | 'filesystem'  | 'filesystem-tags' | null;
  healthCheckKey: string | null;
  cacheConfig: { [key: string]: string };
  timeout: number;
  port: string;
  host: string;
  width: number;
  widthMobile: number;
  height: number;
  heightMobile: number;
  setUserAgentMobile: boolean;
  reqHeaders: { [key: string]: string };
  headers: { [key: string]: string };
  puppeteerArgs: Array<string>;
  renderOnly: Array<string>;
  closeBrowser: boolean;
  restrictedUrlPattern: string | null;
  stripSelectors: string;
  querySelectorAll: string;
};

export class ConfigManager {
  public static config: Config = {
    cache: null,
    healthCheckKey: null,
    cacheConfig: {
      snapshotDir: path.join(os.tmpdir(), 'rendertron'),
      cacheDurationMinutes: (60 * 24).toString(),
      cacheMaxEntries: '100',
    },
    timeout: 10000,
    port: '3000',
    host: '0.0.0.0',
    width: 1280,
    widthMobile: 768,
    height: 1280,
    heightMobile: 768,
    setUserAgentMobile: true,
    reqHeaders: {},
    headers: {},
    puppeteerArgs: ['--no-sandbox'],
    renderOnly: [],
    closeBrowser: false,
    restrictedUrlPattern: null,
    stripSelectors: 'script:not([type]), script[type*="javascript"], script[type="module"], link[rel=import]',
    querySelectorAll: 'main > form, main > [class*="-bannerImage-"], main > [class*="main-page-"], main > [class*="-RootComponents-"], [class*="-breadcrumbs-"], main > [class*="-errorView-"], main > [class*="-layoutContainer-"], main > [class*="-productFullDetail-"] form, main > [class*="-ProductFullDetail-"], main > div > [class*="-components-base-grid-"], main > div > [class*="-contentBlocks-"], main > div > [class*="-summaryFinder-"], main > h1'
  };

  static async getConfiguration(): Promise<Config> {
    // Load config.json if it exists.
    if (fse.pathExistsSync(CONFIG_PATH)) {
      const configJson = await fse.readJson(CONFIG_PATH);

      // merge cacheConfig
      const cacheConfig = Object.assign(
        ConfigManager.config.cacheConfig,
        configJson.cacheConfig
      );

      ConfigManager.config = Object.assign(ConfigManager.config, configJson);

      ConfigManager.config.cacheConfig = cacheConfig;
    }
    return ConfigManager.config;
  }
}
