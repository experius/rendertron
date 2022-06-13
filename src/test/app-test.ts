/*
 * Copyright 2018 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

import test, { ExecutionContext } from 'ava';
import Koa from 'koa';
import koaStatic from 'koa-static';
import path from 'path';
import request from 'supertest';
// import fs from 'fs';
// import os from 'os';

import { Rendertron } from '../rendertron';

const app = new Koa();
app.use(koaStatic(path.resolve(__dirname, '../../test-resources')));

const testBase = 'http://localhost:1234/';

let rendertron = new Rendertron();

let server: request.SuperTest<request.Test>;

test.before('Rest startup', async () => {
  server = request(await rendertron.initialize());
  await app.listen(1234);
});

test('health check responds correctly', async (t: ExecutionContext) => {
  const res = await server.get('/_ah/health');
  t.is(res.status, 200);
});

test('Renders non url', async (t: ExecutionContext) => {
  const res = await server.get(`/seo-snap/`);
  t.is(res.status, 500);
});

test('Renders base page', async (t: ExecutionContext) => {
  const res = await server.get(`/seo-snap/${testBase}base-page.html`);
  t.is(res.status, 200);
});

test('Renders base page refreshCache', async (t: ExecutionContext) => {
  const res = await server.get(`/seo-snap/${testBase}base-page.html?refreshCache=true`);

  t.is(res.status, 200);
  t.is(res.body.tags, "  ");
  t.is(res.body.html.match(/<title[^>]*>([^<]+)<\/title>/)[1], "Base page");
  t.is(res.header['content-type'], 'application/json; charset=utf-8');
});

test('Renders base page js', async (t: ExecutionContext) => {
  const res = await server.get(`/seo-snap/${testBase}base-page-js.html?refreshCache=true`);

  t.is(res.status, 200);
  t.is(res.body.tags, "  ");
  t.is(res.body.html.match(/<h1[^>]*>([^<]+)<\/h1>/)[1], "Injected h1 tag");
  t.is(res.header['content-type'], 'application/json; charset=utf-8');
});

// // TODO why does this timeout..
test('Non existing page', async (t: ExecutionContext) => {
  const res = await server.get(`/seo-snap/${testBase}non-existing.html`);

  console.log("test");
  console.log(res.status);
  console.log(res.body);
  console.log(res.error);

  t.is(res.status, 500);
});

// test.after('Rest startup', async (t: ExecutionContext) => {
//   console.log("done????");
//   console.log("done????");
//   console.log("done????");
//   console.log("done????");
//   console.log("done????");
//   console.log(t);
//
//   rendertron = new Rendertron();
//   server = request(rendertron.initialize());
//   await app.listen(1234);
// });
//
// test('Render base page refreshCache no h1 tag', async (t: ExecutionContext) => {
//   let r = await server.get(`/seo-snap/${testBase}base-page-no-h1.html?refreshCache=true`);
//
//   t.is(r.status, 500);
// });
