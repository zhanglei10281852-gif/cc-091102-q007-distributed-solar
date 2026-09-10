import test from 'node:test'; import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises';
test('样例覆盖相同申请号的不同县域', async () => { const item=JSON.parse(await readFile(new URL('../fixtures/incident.json', import.meta.url))); assert.equal(item.requests[0].requestId,item.requests[1].requestId); assert.notEqual(item.requests[0].tenant,item.requests[1].tenant); });
