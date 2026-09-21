import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';

const TOKENS = {
  tProvince: 't-province',
  tAdminA: 't-admin-a',
  tAdminB: 't-admin-b',
  tOpA1: 't-op-a1',
};

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app.handler);
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function api(base, token, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test.beforeEach(async () => {
  // 每个用例独立应用实例
});

test('HTTP: 无令牌 401', async () => {
  const app = createApp();
  const { server, base } = await startServer(app);
  try {
    const r = await api(base, null, 'GET', '/requests');
    assert.equal(r.status, 401);
  } finally {
    server.close();
  }
});

test('HTTP: 双县同号端到端隔离 + 错误响应不可区分', async () => {
  const app = createApp({ tokens: { [TOKENS.tAdminA]: { id: 'a', role: 'county-admin', tenant: 'county-a' }, [TOKENS.tAdminB]: { id: 'b', role: 'county-admin', tenant: 'county-b' }, [TOKENS.tProvince]: { id: 'p', role: 'province' } } });
  const { server, base } = await startServer(app);
  try {
    const win = { start: '2026-09-21T10:00:00Z', end: '2026-09-21T11:00:00Z' };

    const a1 = await api(base, TOKENS.tAdminA, 'POST', '/requests', { requestId: 'SAMPLE-1', siteRef: 'HA-7', operator: 'op-1', topicCodes: ['T1'] });
    const b1 = await api(base, TOKENS.tAdminB, 'POST', '/requests', { requestId: 'SAMPLE-1', siteRef: 'HB-9', operator: 'op-9', topicCodes: ['T1'] });
    assert.equal(a1.status, 201);
    assert.equal(b1.status, 201);

    await api(base, TOKENS.tAdminA, 'POST', '/requests/SAMPLE-1/negotiate');
    await api(base, TOKENS.tAdminA, 'POST', '/requests/SAMPLE-1/lock-window', win);
    await api(base, TOKENS.tAdminA, 'POST', '/requests/SAMPLE-1/approve');

    // B 县同号状态链独立
    const bView = await api(base, TOKENS.tAdminB, 'GET', '/requests/SAMPLE-1');
    assert.equal(bView.json.state, 'submitted');

    // 跨县探测、真不存在、省级探测三者响应同构
    const cross = await api(base, TOKENS.tAdminB, 'GET', '/requests/SAMPLE-1-NOPE');
    const provinceProbe = await api(base, TOKENS.tProvince, 'GET', '/requests/SAMPLE-1');
    const provinceMiss = await api(base, TOKENS.tProvince, 'GET', '/requests/NOPE');
    assert.equal(cross.status, 404);
    assert.equal(provinceProbe.status, 404);
    assert.equal(provinceMiss.status, 404);
    assert.deepEqual(cross.json, provinceProbe.json);
    assert.deepEqual(provinceProbe.json, provinceMiss.json);

    // 省级聚合：数字准确且无标识泄露
    const stats = await api(base, TOKENS.tProvince, 'GET', '/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.json.tenants['county-a'].byState.approved, 1);
    assert.equal(stats.json.tenants['county-b'].byState.submitted, 1);
    const text = JSON.stringify(stats.json);
    for (const leak of ['HA-7', 'HB-9', 'op-1', 'op-9']) assert.ok(!text.includes(leak));

    // 越权全部进审计流（省级两次探明细；县级在结构上无法寻址邻县）
    const audit = await api(base, TOKENS.tProvince, 'GET', '/audit');
    assert.equal(audit.status, 200);
    const denied = audit.json.entries.filter((e) => e.result === 'denied');
    assert.ok(denied.length >= 2);
    assert.ok(denied.every((e) => e.event === 'cross-scope-attempt' || e.event === 'authenticate-failed'));

    // 非省级读审计端点同样 404
    const auditDenied = await api(base, TOKENS.tAdminA, 'GET', '/audit');
    assert.equal(auditDenied.status, 404);
  } finally {
    server.close();
  }
});

test('HTTP: 载荷租户不匹配（误并县）被拒并审计', async () => {
  const app = createApp({ tokens: { [TOKENS.tAdminA]: { id: 'a', role: 'county-admin', tenant: 'county-a' }, [TOKENS.tProvince]: { id: 'p', role: 'province' } } });
  const { server, base } = await startServer(app);
  try {
    const r = await api(base, TOKENS.tAdminA, 'POST', '/requests', {
      tenant: 'county-b',
      requestId: 'SAMPLE-1',
      siteRef: 'HB-9',
      operator: 'op-9',
    });
    assert.equal(r.status, 404);
    const audit = await api(base, TOKENS.tProvince, 'GET', '/audit');
    assert.ok(audit.json.entries.some((e) => e.reason === 'payload-tenant-mismatch' && e.targetTenant === 'county-b'));
    // A 县列表中不存在该记录
    const list = await api(base, TOKENS.tAdminA, 'GET', '/requests');
    assert.equal(list.json.requests.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP: 运营商属主隔离', async () => {
  const app = createApp({
    tokens: {
      [TOKENS.tOpA1]: { id: 'o1', role: 'operator', tenant: 'county-a', operator: 'op-1' },
      [TOKENS.tAdminA]: { id: 'a', role: 'county-admin', tenant: 'county-a' },
    },
  });
  const { server, base } = await startServer(app);
  try {
    await api(base, TOKENS.tAdminA, 'POST', '/requests', { requestId: 'R-OWNED', siteRef: 'HA-1', operator: 'op-2' });
    const list = await api(base, TOKENS.tOpA1, 'GET', '/requests');
    assert.deepEqual(list.json.requests, []);
    const cancel = await api(base, TOKENS.tOpA1, 'POST', '/requests/R-OWNED/cancel', {});
    assert.equal(cancel.status, 403);
  } finally {
    server.close();
  }
});
