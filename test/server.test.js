import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createApp, createPlatform } from '../src/server.js';

const countyA = { id: 'user-a', role: 'county-user', tenant: 'county-a' };
const countyB = { id: 'user-b', role: 'county-user', tenant: 'county-b' };
const admin = { id: 'admin-1', role: 'province-admin' };

async function boot() {
  const platform = createPlatform();
  const server = createServer(createApp(platform));
  await new Promise(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { actor, body } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(actor
          ? {
              'x-actor-id': actor.id,
              'x-actor-role': actor.role,
              ...(actor.tenant ? { 'x-actor-tenant': actor.tenant } : {}),
            }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const close = () => {
    server.closeAllConnections?.();
    return new Promise(resolve => server.close(resolve));
  };
  return { platform, call, close };
}

test('状态接口沿用既有负载', async () => {
  const { call, close } = await boot();
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { service: 'distributed-solar-sampling', status: 'running' });
  await close();
});

test('缺少身份一律 401', async () => {
  const { call, close } = await boot();
  for (const [method, path] of [['GET', '/aggregate'], ['GET', '/tenants/county-a/requests'], ['POST', '/requests']]) {
    const res = await call(method, path);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  await close();
});

test('双县同号并行：HTTP 全流程隔离、统一 404 与省级聚合', async () => {
  const { platform, call, close } = await boot();
  const fixture = JSON.parse(await readFile(new URL('../fixtures/incident.json', import.meta.url)));
  const [reqA, reqB] = fixture.requests;
  assert.equal(reqA.requestId, reqB.requestId);
  assert.notEqual(reqA.tenant, reqB.tenant);

  // 省级配置两县同名窗口，容量各自独立
  for (const tenant of [reqA.tenant, reqB.tenant]) {
    const res = await call('POST', '/windows', { actor: admin, body: { tenant, windowId: 'W-1', capacity: 1 } });
    assert.equal(res.status, 201);
  }

  // 两县以相同申请号各自申报
  for (const [actor, req] of [[countyA, reqA], [countyB, reqB]]) {
    const res = await call('POST', '/requests', {
      actor,
      body: { operator: 'op-grid', site: req.siteRef, requestId: req.requestId, topicCodes: ['roof-check'] },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.request.tenant, actor.tenant);
  }

  const pathA = `/requests/county-a/op-grid/${reqA.siteRef}/${reqA.requestId}`;
  const pathB = `/requests/county-b/op-grid/${reqB.siteRef}/${reqB.requestId}`;

  // A 县走完整状态链：协商 → 锁窗 → 批复
  assert.equal((await call('POST', `${pathA}/negotiate`, { actor: countyA })).body.request.state, 'negotiating');
  assert.equal(
    (await call('POST', `${pathA}/hold-window`, { actor: countyA, body: { windowId: 'W-1' } })).body.request.state,
    'window-held',
  );
  assert.equal((await call('POST', `${pathA}/approve`, { actor: countyA })).body.request.state, 'approved');

  // B 县同号对象的状态链不受影响
  const bRead = await call('GET', pathB, { actor: countyB });
  assert.equal(bRead.status, 200);
  assert.equal(bRead.body.request.state, 'submitted');

  // 越权读取：显式跨县路径与本域拼他县站点，响应与真实不存在完全一致
  const miss = await call('GET', '/requests/county-b/op-grid/HB-0/NOPE-1', { actor: countyB });
  assert.equal(miss.status, 404);
  const crossPath = await call('GET', pathA, { actor: countyB });
  const crossSite = await call('GET', `/requests/county-b/op-grid/${reqA.siteRef}/${reqA.requestId}`, { actor: countyB });
  for (const res of [crossPath, crossSite]) {
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, miss.body);
  }

  // 省级管理员：明细被拒，聚合准确且不泄露户用站点标识
  assert.equal((await call('GET', pathA, { actor: admin })).status, 403);
  const aggregate = await call('GET', '/aggregate', { actor: admin });
  assert.equal(aggregate.status, 200);
  assert.equal(aggregate.body.aggregate.totals.total, 2);
  assert.equal(aggregate.body.aggregate.totals.byState.approved, 1);
  assert.equal(aggregate.body.aggregate.totals.byState.submitted, 1);
  const payload = JSON.stringify(aggregate.body);
  for (const leaked of [reqA.siteRef, reqB.siteRef, reqA.requestId]) {
    assert.ok(!payload.includes(leaked), `聚合不得泄露 ${leaked}`);
  }

  // 县级用户拿不到聚合
  assert.equal((await call('GET', '/aggregate', { actor: countyA })).status, 403);

  // 越权尝试已进入审计流
  const events = platform.audit.list();
  assert.ok(events.some(e => e.actor === 'user-b' && e.action === 'read' && e.decision === 'deny'));
  assert.ok(events.some(e => e.actor === 'admin-1' && e.decision === 'deny'));
  assert.ok(events.some(e => e.actor === 'user-a' && e.action === 'aggregate'));

  await close();
});

test('同域重复申请返回 409，邻县同号互不影响', async () => {
  const { call, close } = await boot();
  const body = { operator: 'op-grid', site: 'HA-7', requestId: 'SAMPLE-1' };
  assert.equal((await call('POST', '/requests', { actor: countyA, body })).status, 201);
  assert.equal((await call('POST', '/requests', { actor: countyA, body })).status, 409);
  assert.equal((await call('POST', '/requests', { actor: countyB, body: { ...body, site: 'HB-9' } })).status, 201);
  await close();
});

test('县级列表仅含本域数据，跨县列表按不存在处理', async () => {
  const { call, close } = await boot();
  await call('POST', '/requests', { actor: countyA, body: { operator: 'op-grid', site: 'HA-7', requestId: 'SAMPLE-1' } });
  await call('POST', '/requests', { actor: countyB, body: { operator: 'op-grid', site: 'HB-9', requestId: 'SAMPLE-1' } });

  const listA = await call('GET', '/tenants/county-a/requests', { actor: countyA });
  assert.equal(listA.status, 200);
  assert.equal(listA.body.requests.length, 1);
  assert.ok(listA.body.requests.every(record => record.tenant === 'county-a'));

  const cross = await call('GET', '/tenants/county-b/requests', { actor: countyA });
  assert.equal(cross.status, 404);
  await close();
});
