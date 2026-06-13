#!/usr/bin/env node
// 看 getResource 返回是否含 cloud189
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  console.log('[1] getResource (3fb1cb68...)');
  const r = await client.getResource('3fb1cb6823c64ae4a7a0f8f23bd4bed3');
  console.log(JSON.stringify(r.data, null, 2));

  console.log('\n[2] getResource (905baf2b 失效链接)');
  const r2 = await client.getResource('905baf2b010911ee89d70242ac130004');
  console.log(JSON.stringify(r2.data, null, 2).slice(0, 1000));
} catch (e) {
  console.error(e.message);
} finally {
  await client.close();
}