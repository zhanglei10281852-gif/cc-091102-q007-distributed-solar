import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, AuditLog, ROLES } from '../src/auth.js';
import { ScopedStore } from '../src/store.js';
import { SamplingService, requestStates } from '../src/service.js';
import { findTopicOverlap } from '../src/domain.js';

const province = { id: 'p1', role: ROLES.PROVINCE };
const adminA = { id: 'a1', role: ROLES.COUNTY_ADMIN, tenant: 'county-a' };
const adminB = { id: 'b1', role: ROLES.COUNTY_ADMIN, tenant: 'county-b' };
const opA1 = { id: 'o1', role: ROLES.OPERATOR, tenant: 'county-a', operator: 'op-1' };
const opA2 = { id: 'o2', role: ROLES.OPERATOR, tenant: 'county-a', operator: 'op-2' };

function makeService({ now = 1_000_000, ttl = 1000, capacities } = {}) {
  let clock = now;
  const audit = new AuditLog();
  const auth = new AuthService(audit);
  const service = new SamplingService(new ScopedStore(), auth, {
    clock: () => clock,
    windowTtlMs: ttl,
    capacities,
  });
  return {
    audit,
    auth,
    service,
    tick: (ms) => {
      clock += ms;
    },
    setClock: (v) => {
      clock = v;
    },
  };
}

test('双县同号：相同申请号在两个县各自独立创建、状态链互不影响', () => {
  const { service } = makeService();
  const a = service.createRequest(adminA, { requestId: 'SAMPLE-1', siteRef: 'HA-7', operator: 'op-1', topicCodes: ['T1'] });
  const b = service.createRequest(adminB, { requestId: 'SAMPLE-1', siteRef: 'HB-9', operator: 'op-9', topicCodes: ['T1'] });

  assert.equal(a.tenant, 'county-a');
  assert.equal(b.tenant, 'county-b');
  assert.equal(a.siteRef, 'HA-7');
  assert.equal(b.siteRef, 'HB-9');

  // A 县推进整条状态链，B 县同号记录仍停留在 submitted。
  const n = service.negotiate(adminA, 'SAMPLE-1');
  assert.equal(n.state, 'negotiating');
  const held = service.lockWindow(adminA, 'SAMPLE-1', { start: '2026-09-21T10:00:00Z', end: '2026-09-21T11:00:00Z' });
  assert.equal(held.state, 'window-held');
  const approved = service.approve(adminA, 'SAMPLE-1');
  assert.equal(approved.state, 'approved');

  const bView = service.getRequest(adminB, 'SAMPLE-1');
  assert.equal(bView.state, 'submitted');
  assert.equal(bView.window, null);

  // 反向亦然：B 县取消不影响 A 县已核准记录。
  service.cancel(adminB, 'SAMPLE-1');
  assert.equal(service.getRequest(adminA, 'SAMPLE-1').state, 'approved');
  assert.equal(service.getRequest(adminB, 'SAMPLE-1').state, 'cancelled');
});

test('双县同号：一县容量耗尽不影响另一县同号窗口', () => {
  // 每县容量 1：A 县 SAMPLE-1 持窗后，同县另一条被拒；B 县同号仍可锁窗。
  const { service } = makeService({ capacities: { 'county-a': 1, 'county-b': 1 } });
  service.createRequest(adminA, { requestId: 'SAMPLE-1', siteRef: 'HA-7', operator: 'op-1', topicCodes: [] });
  service.createRequest(adminA, { requestId: 'SAMPLE-2', siteRef: 'HA-8', operator: 'op-1', topicCodes: [] });
  service.createRequest(adminB, { requestId: 'SAMPLE-1', siteRef: 'HB-9', operator: 'op-9', topicCodes: [] });

  const win = { start: '2026-09-21T10:00:00Z', end: '2026-09-21T11:00:00Z' };
  service.lockWindow(adminA, 'SAMPLE-1', win);
  assert.throws(() => service.lockWindow(adminA, 'SAMPLE-2', win), /capacity/);

  const bHeld = service.lockWindow(adminB, 'SAMPLE-1', win);
  assert.equal(bHeld.state, 'window-held');
});

test('县级用户只能看到本域数据，列表不泄露邻县站点', () => {
  const { service } = makeService();
  service.createRequest(adminA, { requestId: 'SAMPLE-1', siteRef: 'HA-7', operator: 'op-1' });
  service.createRequest(adminB, { requestId: 'SAMPLE-1', siteRef: 'HB-9', operator: 'op-9' });

  const listA = service.listRequests(adminA);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].siteRef, 'HA-7');
  assert.equal(listA[0].tenant, 'county-a');
  assert.ok(!JSON.stringify(listA).includes('HB-9'));
});

test('跨县读取与普通未命中响应同构（404），且不泄露对象存在性', () => {
  const { service, audit } = makeService();
  service.createRequest(adminA, { requestId: 'SAMPLE-1', siteRef: 'HA-7', operator: 'op-1' });

  // 租户永远取自令牌：adminB 查询 SAMPLE-1 只在本县命名空间内寻址，
  // 结构上不可能碰到 A 县记录；响应与普通未命中逐字节同构。
  assert.throws(() => service.getRequest(adminB, 'SAMPLE-1'), { status: 404, code: 'not-found' });
  assert.throws(() => service.getRequest(adminB, 'SAMPLE-X'), { status: 404, code: 'not-found' });
  // 本县主体正常可读
  assert.equal(service.getRequest(adminA, 'SAMPLE-1').state, 'submitted');

  // 普通未命中不产生越权审计（真实跨租户向量——载荷携带他县租户、省级探明细——才审计）
  assert.equal(audit.list((e) => e.event === 'cross-scope-attempt').length, 0);
});

test('载荷携带他县租户（误合并/越权）进入审计流', () => {
  const { service, audit } = makeService();
  assert.throws(
    () => service.createRequest(adminB, { tenant: 'county-a', requestId: 'SAMPLE-1', siteRef: 'HA-7', operator: 'op-1' }),
    { status: 404 },
  );
  const entries = audit.list((e) => e.event === 'cross-scope-attempt');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].principalTenant, 'county-b');
  assert.equal(entries[0].targetTenant, 'county-a');
  assert.equal(entries[0].reason, 'payload-tenant-mismatch');
});

test('缓存命中不能跨租户：同号缓存各归各县，写后失效', () => {
  const { service, audit } = makeService();
  service.createRequest(adminA, { requestId: 'SAMPLE-1', siteRef: 'HA-7', operator: 'op-1' });
  service.createRequest(adminB, { requestId: 'SAMPLE-1', siteRef: 'HB-9', operator: 'op-9' });

  // 连续两次读 A 县（第二次走版本化缓存）
  assert.equal(service.getRequest(adminA, 'SAMPLE-1').siteRef, 'HA-7');
  assert.equal(service.getRequest(adminA, 'SAMPLE-1').siteRef, 'HA-7');
  // B 县同号读到的是自己的记录，而不是 A 的缓存条目
  assert.equal(service.getRequest(adminB, 'SAMPLE-1').siteRef, 'HB-9');

  // B 县写入后缓存失效，再读得到新状态
  service.cancel(adminB, 'SAMPLE-1');
  assert.equal(service.getRequest(adminB, 'SAMPLE-1').state, 'cancelled');
  // A 县记录不受 B 县写入影响
  assert.equal(service.getRequest(adminA, 'SAMPLE-1').state, 'submitted');
  assert.equal(audit.list((e) => e.event === 'cross-scope-attempt').length, 0);
});

test('省级账号访问明细一律 404 并审计，无法探测对象是否存在', () => {
  const { service, audit } = makeService();
  service.createRequest(adminA, { requestId: 'EXISTS', siteRef: 'HA-1', operator: 'op-1' });
  assert.throws(() => service.getRequest(province, 'EXISTS'), { status: 404 });
  assert.throws(() => service.getRequest(province, 'MISSING'), { status: 404 });
  assert.throws(() => service.listRequests(province), { status: 404 });
  assert.equal(audit.list((e) => e.event === 'cross-scope-attempt').length, 3);
});

test('省级聚合只有按县计数，不含任何站点/申请标识', () => {
  const { service } = makeService();
  service.createRequest(adminA, { requestId: 'R1', siteRef: 'HA-1', operator: 'op-1' });
  service.createRequest(adminA, { requestId: 'R2', siteRef: 'HA-2', operator: 'op-2' });
  service.createRequest(adminB, { requestId: 'R1', siteRef: 'HB-9', operator: 'op-9' });
  service.cancel(adminB, 'R1');

  const stats = service.stats(province);
  assert.equal(stats.scope, 'province');
  assert.equal(stats.tenants['county-a'].total, 2);
  assert.equal(stats.tenants['county-a'].byState.submitted, 2);
  assert.equal(stats.tenants['county-b'].byState.cancelled, 1);

  const json = JSON.stringify(stats);
  for (const leak of ['HA-1', 'HA-2', 'HB-9', 'R1', 'R2', 'op-1', 'op-9']) {
    assert.ok(!json.includes(leak), `省级聚合泄露标识: ${leak}`);
  }
});

test('县级统计仅本域，且与双县并行写入保持准确', () => {
  const { service } = makeService();
  service.createRequest(adminA, { requestId: 'R1', siteRef: 'HA-1', operator: 'op-1' });
  service.createRequest(adminB, { requestId: 'R1', siteRef: 'HB-1', operator: 'op-9' });
  const sA = service.stats(adminA);
  assert.equal(sA.scope, 'tenant');
  assert.equal(sA.tenant, 'county-a');
  assert.equal(sA.total, 1);
  assert.equal(sA.byState.submitted, 1);
});

test('主题重合协商仅在同租户活动申请间计算，跨县不串', () => {
  const { service } = makeService();
  service.createRequest(adminA, { requestId: 'R1', siteRef: 'HA-1', operator: 'op-1', topicCodes: ['T-X', 'T-Y'] });
  service.createRequest(adminA, { requestId: 'R2', siteRef: 'HA-2', operator: 'op-2', topicCodes: ['T-Y'] });
  service.createRequest(adminB, { requestId: 'R9', siteRef: 'HB-1', operator: 'op-9', topicCodes: ['T-Y'] });

  const result = service.negotiate(adminA, 'R1');
  assert.equal(result.state, 'negotiating');
  assert.equal(result.topicOverlaps.length, 1);
  assert.equal(result.topicOverlaps[0].requestId, 'R2');
  assert.deepEqual(result.topicOverlaps[0].sharedTopicCodes, ['T-Y']);
  // 协商结果不得出现邻县记录
  assert.ok(!JSON.stringify(result).includes('R9'));
});

test('findTopicOverlap 纯函数在已限定作用域集合上工作', () => {
  const scoped = [{ requestId: 'R1', topicCodes: ['a'] }, { requestId: 'R2', topicCodes: ['b'] }];
  assert.deepEqual(findTopicOverlap(scoped, ['a']).map((r) => r.requestId), ['R1']);
});

test('状态链非法流转被拒', () => {
  const { service } = makeService();
  service.createRequest(adminA, { requestId: 'R1', siteRef: 'HA-1', operator: 'op-1' });
  assert.throws(() => service.approve(adminA, 'R1'), /cannot approve/);
  const win = { start: '2026-09-21T10:00:00Z', end: '2026-09-21T11:00:00Z' };
  service.negotiate(adminA, 'R1');
  service.lockWindow(adminA, 'R1', win);
  assert.throws(() => service.lockWindow(adminA, 'R1', win), /cannot lock/);
  service.approve(adminA, 'R1');
  assert.throws(() => service.cancel(adminA, 'R1'), /cannot be cancelled/);
});

test('同租户同站点时间重叠窗口被拒，不重叠可锁', () => {
  const { service } = makeService({ capacities: { 'county-a': 10 } });
  service.createRequest(adminA, { requestId: 'R1', siteRef: 'HA-1', operator: 'op-1' });
  service.createRequest(adminA, { requestId: 'R2', siteRef: 'HA-1', operator: 'op-1' });
  service.lockWindow(adminA, 'R1', { start: '2026-09-21T10:00:00Z', end: '2026-09-21T11:00:00Z' });
  assert.throws(
    () => service.lockWindow(adminA, 'R2', { start: '2026-09-21T10:30:00Z', end: '2026-09-21T11:30:00Z' }),
    /site already/,
  );
  const ok = service.lockWindow(adminA, 'R2', { start: '2026-09-21T12:00:00Z', end: '2026-09-21T13:00:00Z' });
  assert.equal(ok.state, 'window-held');
});

test('窗口持锁 TTL 过期后惰性释放容量并回退 negotiating', () => {
  const { service, tick } = makeService({ ttl: 1000, capacities: { 'county-a': 1 } });
  service.createRequest(adminA, { requestId: 'R1', siteRef: 'HA-1', operator: 'op-1' });
  service.createRequest(adminA, { requestId: 'R2', siteRef: 'HA-2', operator: 'op-1' });
  const win = { start: '2026-09-21T10:00:00Z', end: '2026-09-21T11:00:00Z' };
  service.lockWindow(adminA, 'R1', win);
  assert.throws(() => service.lockWindow(adminA, 'R2', win), /capacity/);
  tick(1001);
  // 读取触发 R1 惰性过期后，容量释放，R2 可锁
  service.getRequest(adminA, 'R1');
  const r2 = service.lockWindow(adminA, 'R2', win);
  assert.equal(r2.state, 'window-held');
  assert.equal(service.getRequest(adminA, 'R1').state, 'negotiating');
});

test('运营商只能操作本主体记录，跨主体写为 403 且审计', () => {
  const { service, audit } = makeService();
  service.createRequest(opA1, { requestId: 'R1', siteRef: 'HA-1' });
  // 列表只含本人记录
  assert.equal(service.listRequests(opA1).length, 1);
  assert.equal(service.listRequests(opA2).length, 0);
  // opA2 同租户但非属主：403（此时已在本县内，不存在存在性泄露）
  assert.throws(() => service.cancel(opA2, 'R1'), { status: 403, code: 'forbidden' });
  assert.equal(audit.list((e) => e.event === 'authorization-denied').length, 1);
  // 属主自己可以推进
  service.negotiate(opA1, 'R1');
});

test('运营商无法伪造属主；县级管理员可代填 operator', () => {
  const { service } = makeService();
  const created = service.createRequest(opA1, { requestId: 'R1', siteRef: 'HA-1', operator: 'op-evil' });
  assert.equal(created.operator, 'op-1');
  const byAdmin = service.createRequest(adminA, { requestId: 'R2', siteRef: 'HA-2', operator: 'op-2' });
  assert.equal(byAdmin.operator, 'op-2');
});

test('同租户重复申请号 409，跨县同号不冲突', () => {
  const { service } = makeService();
  service.createRequest(adminA, { requestId: 'DUP', siteRef: 'HA-1', operator: 'op-1' });
  assert.throws(() => service.createRequest(adminA, { requestId: 'DUP', siteRef: 'HA-2', operator: 'op-1' }), {
    status: 409,
    code: 'duplicate-request',
  });
  assert.doesNotThrow(() => service.createRequest(adminB, { requestId: 'DUP', siteRef: 'HB-1', operator: 'op-9' }));
});

test('状态常量保持五个既定状态', () => {
  assert.deepEqual(requestStates, ['submitted', 'negotiating', 'window-held', 'approved', 'cancelled']);
});
