import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';
import { createStore } from '../src/store.js';
import { createScopedCache } from '../src/cache.js';
import { createAuditStream } from '../src/audit.js';
import { createActor } from '../src/context.js';
import { errorCodes } from '../src/errors.js';

function setup() {
  const store = createStore();
  const cache = createScopedCache();
  const audit = createAuditStream();
  const service = createService({ store, cache, audit });
  const admin = createActor({ id: 'admin-1', role: 'province-admin' });
  const userA = createActor({ id: 'user-a', role: 'county-user', tenant: 'county-a' });
  const userB = createActor({ id: 'user-b', role: 'county-user', tenant: 'county-b' });
  return { store, cache, audit, service, admin, userA, userB };
}

const refOf = record => ({
  tenant: record.tenant,
  operator: record.operator,
  site: record.site,
  requestId: record.requestId,
});

const catchError = fn => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('应当抛出错误');
};

function applyIn(service, actor, overrides = {}) {
  return service.apply(actor, {
    operator: 'op-grid',
    site: actor.tenant === 'county-a' ? 'HA-7' : 'HB-9',
    requestId: 'SAMPLE-1',
    topicCodes: ['roof-check'],
    ...overrides,
  });
}

test('双县并行处理相同申请号：容量与状态链互不影响', () => {
  const { service, admin, userA, userB } = setup();
  service.defineWindow(admin, { tenant: 'county-a', windowId: 'W-01', capacity: 1 });
  service.defineWindow(admin, { tenant: 'county-b', windowId: 'W-01', capacity: 1 });

  const a = applyIn(service, userA);
  const b = applyIn(service, userB);
  assert.equal(a.requestId, b.requestId);
  assert.notEqual(a.site, b.site);

  service.negotiate(userA, refOf(a));
  service.holdWindow(userA, refOf(a), 'W-01');
  const approvedA = service.approve(userA, refOf(a));
  assert.equal(approvedA.state, 'approved');
  assert.deepEqual(approvedA.history.map(h => h.to), ['submitted', 'negotiating', 'window-held', 'approved']);

  // B 县同号对象的状态链与窗口水位均未受 A 县影响
  const stillB = service.getRequest(userB, refOf(b));
  assert.equal(stillB.state, 'submitted');
  assert.deepEqual(stillB.history.map(h => h.to), ['submitted']);
  assert.equal(service.tenantStats(userB).windows['W-01'].remaining, 1);

  service.negotiate(userB, refOf(b));
  assert.equal(service.holdWindow(userB, refOf(b), 'W-01').state, 'window-held');
  assert.equal(service.tenantStats(userA).windows['W-01'].remaining, 0);
  assert.equal(service.tenantStats(userB).windows['W-01'].remaining, 0);
});

test('窗口容量按县域隔离，邻县占满不影响本县', () => {
  const { service, admin, userA, userB } = setup();
  service.defineWindow(admin, { tenant: 'county-a', windowId: 'W-02', capacity: 1 });
  service.defineWindow(admin, { tenant: 'county-b', windowId: 'W-02', capacity: 2 });

  const a1 = applyIn(service, userA, { site: 'HA-1', requestId: 'A-1' });
  const a2 = applyIn(service, userA, { site: 'HA-2', requestId: 'A-2' });
  service.negotiate(userA, refOf(a1));
  service.holdWindow(userA, refOf(a1), 'W-02');
  service.negotiate(userA, refOf(a2));
  assert.equal(catchError(() => service.holdWindow(userA, refOf(a2), 'W-02')).code, errorCodes.WINDOW_FULL);

  // 邻县同号同窗口仍有余量
  const b1 = applyIn(service, userB, { requestId: 'A-1', site: 'HB-1' });
  service.negotiate(userB, refOf(b1));
  assert.equal(service.holdWindow(userB, refOf(b1), 'W-02').state, 'window-held');
  assert.equal(service.tenantStats(userB).windows['W-02'].remaining, 1);
});

test('主题重合协商只在本县域内进行', () => {
  const { service, userA, userB } = setup();
  const a1 = applyIn(service, userA, { site: 'HA-1', requestId: 'A-1', topicCodes: ['roof'] });
  applyIn(service, userA, { site: 'HA-2', requestId: 'A-2', topicCodes: ['roof'] });
  applyIn(service, userB, { site: 'HB-1', requestId: 'B-1', topicCodes: ['roof'] });

  const negotiated = service.negotiate(userA, refOf(a1));
  assert.equal(negotiated.state, 'negotiating');
  assert.deepEqual(negotiated.negotiation.overlaps.map(o => o.requestId), ['A-2']);
  assert.ok(!JSON.stringify(negotiated).includes('HB-1'), '协商结果不得包含邻县站点');
});

test('取消释放窗口容量，终止态不可再迁移', () => {
  const { service, admin, userA } = setup();
  service.defineWindow(admin, { tenant: 'county-a', windowId: 'W-03', capacity: 1 });
  const a1 = applyIn(service, userA, { site: 'HA-1', requestId: 'A-1' });
  service.negotiate(userA, refOf(a1));
  service.holdWindow(userA, refOf(a1), 'W-03');
  assert.equal(service.tenantStats(userA).windows['W-03'].remaining, 0);

  const cancelled = service.cancel(userA, refOf(a1));
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(service.tenantStats(userA).windows['W-03'].remaining, 1);

  assert.equal(catchError(() => service.cancel(userA, refOf(a1))).code, errorCodes.INVALID_STATE);
  assert.equal(catchError(() => service.approve(userA, refOf(a1))).code, errorCodes.INVALID_STATE);

  // 容量已释放，同县另一申请可锁定同一窗口
  const a2 = applyIn(service, userA, { site: 'HA-2', requestId: 'A-2' });
  service.negotiate(userA, refOf(a2));
  assert.equal(service.holdWindow(userA, refOf(a2), 'W-03').state, 'window-held');
});

test('非法状态迁移被拒绝且原状态不变', () => {
  const { service, admin, userA } = setup();
  service.defineWindow(admin, { tenant: 'county-a', windowId: 'W-04', capacity: 1 });
  const a1 = applyIn(service, userA, { site: 'HA-1', requestId: 'A-1' });
  assert.equal(catchError(() => service.holdWindow(userA, refOf(a1), 'W-04')).code, errorCodes.INVALID_STATE);
  assert.equal(catchError(() => service.approve(userA, refOf(a1))).code, errorCodes.INVALID_STATE);
  assert.equal(service.getRequest(userA, refOf(a1)).state, 'submitted');
});

test('越权读取与真实不存在返回完全一致，并进入审计流', () => {
  const { service, audit, userA, userB } = setup();
  applyIn(service, userA, { site: 'HA-7', requestId: 'SAMPLE-1' });

  const genuineMiss = catchError(() =>
    service.getRequest(userB, { tenant: 'county-b', operator: 'op-grid', site: 'HB-1', requestId: 'NOPE-1' }));
  const crossProbe = catchError(() =>
    service.getRequest(userB, { tenant: 'county-b', operator: 'op-grid', site: 'HA-7', requestId: 'SAMPLE-1' }));
  const explicitCross = catchError(() =>
    service.getRequest(userB, { tenant: 'county-a', operator: 'op-grid', site: 'HA-7', requestId: 'SAMPLE-1' }));

  for (const error of [crossProbe, explicitCross]) {
    assert.equal(error.code, errorCodes.NOT_FOUND);
    assert.equal(error.message, genuineMiss.message);
  }
  // 真实不存在不记审计；两种越权形态各记一条
  assert.equal(audit.size, 2);
  assert.deepEqual(audit.list().map(e => e.reason).sort(), ['cross-tenant-probe', 'cross-tenant-scope']);
  assert.ok(audit.list().every(e => e.actor === 'user-b' && e.decision === 'deny'));
});

test('省级管理员仅见聚合，明细与写操作被拒并入审计', () => {
  const { service, audit, admin, userA, userB } = setup();
  const a = applyIn(service, userA, { site: 'HA-7', requestId: 'SAMPLE-1' });
  applyIn(service, userB, { site: 'HB-9', requestId: 'SAMPLE-1' });
  service.negotiate(userA, refOf(a));

  assert.equal(
    catchError(() => service.getRequest(admin, { tenant: 'county-a', operator: 'op-grid', site: 'HA-7', requestId: 'SAMPLE-1' })).code,
    errorCodes.FORBIDDEN,
  );
  assert.equal(
    catchError(() => service.apply(admin, { tenant: 'county-a', operator: 'op', site: 'X-1', requestId: 'Z-1' })).code,
    errorCodes.FORBIDDEN,
  );
  assert.equal(catchError(() => service.listRequests(admin, 'county-a')).code, errorCodes.FORBIDDEN);

  const aggregate = service.aggregate(admin);
  assert.equal(aggregate.totals.total, 2);
  assert.equal(aggregate.totals.byState.negotiating, 1);
  assert.equal(aggregate.totals.byState.submitted, 1);
  assert.equal(aggregate.tenants['county-a'].total, 1);
  assert.equal(aggregate.tenants['county-b'].total, 1);

  const payload = JSON.stringify(aggregate);
  for (const leaked of ['HA-7', 'HB-9', 'SAMPLE-1']) {
    assert.ok(!payload.includes(leaked), `聚合不得包含 ${leaked}`);
  }
  assert.ok(audit.list().filter(e => e.actor === 'admin-1').length >= 3);
});

test('县级用户只看本域：列表、统计、聚合与窗口配置边界', () => {
  const { service, audit, userA, userB } = setup();
  applyIn(service, userA, { site: 'HA-7', requestId: 'SAMPLE-1' });
  applyIn(service, userB, { site: 'HB-9', requestId: 'SAMPLE-1' });

  const listA = service.listRequests(userA);
  assert.equal(listA.length, 1);
  assert.ok(listA.every(record => record.tenant === 'county-a'));

  assert.equal(catchError(() => service.listRequests(userA, 'county-b')).code, errorCodes.NOT_FOUND);
  assert.equal(catchError(() => service.tenantStats(userA, 'county-b')).code, errorCodes.NOT_FOUND);
  assert.equal(catchError(() => service.aggregate(userA)).code, errorCodes.FORBIDDEN);
  assert.equal(
    catchError(() => service.defineWindow(userA, { tenant: 'county-a', windowId: 'W', capacity: 1 })).code,
    errorCodes.FORBIDDEN,
  );
  assert.equal(audit.size, 4);
});

test('读取缓存按作用域隔离，相同申请号不串号', () => {
  const { service, cache, userA, userB } = setup();
  const a = applyIn(service, userA, { site: 'HA-7', requestId: 'SAMPLE-1' });
  assert.ok(cache.size >= 1);

  // A 县读取后缓存已热，B 县同号同站查询仍不得命中邻县记录
  assert.equal(service.getRequest(userA, refOf(a)).site, 'HA-7');
  assert.equal(
    catchError(() => service.getRequest(userB, { tenant: 'county-b', operator: 'op-grid', site: 'HA-7', requestId: 'SAMPLE-1' })).code,
    errorCodes.NOT_FOUND,
  );

  const b = applyIn(service, userB, { site: 'HB-9', requestId: 'SAMPLE-1' });
  assert.equal(service.getRequest(userB, refOf(b)).site, 'HB-9');
  assert.equal(service.getRequest(userA, refOf(a)).site, 'HA-7');
});

test('运营商是共同作用域的一部分', () => {
  const { service, audit, userA } = setup();
  const east = applyIn(service, userA, { operator: 'op-east', site: 'HA-7', requestId: 'SAMPLE-1' });
  const west = applyIn(service, userA, { operator: 'op-west', site: 'HA-7', requestId: 'SAMPLE-1' });
  assert.notEqual(east.operator, west.operator);

  const opUser = createActor({ id: 'user-ae', role: 'county-user', tenant: 'county-a', operator: 'op-east' });
  assert.equal(
    service.getRequest(opUser, { operator: 'op-east', site: 'HA-7', requestId: 'SAMPLE-1' }).operator,
    'op-east',
  );
  assert.equal(
    catchError(() => service.getRequest(opUser, { operator: 'op-west', site: 'HA-7', requestId: 'SAMPLE-1' })).code,
    errorCodes.NOT_FOUND,
  );
  assert.equal(audit.size, 1);
});

test('同作用域申请号冲突，邻县同号不冲突', () => {
  const { service, userA, userB } = setup();
  applyIn(service, userA, { site: 'HA-7', requestId: 'SAMPLE-1' });
  assert.equal(catchError(() => applyIn(service, userA, { site: 'HA-7', requestId: 'SAMPLE-1' })).code, errorCodes.CONFLICT);
  assert.doesNotThrow(() => applyIn(service, userB, { site: 'HB-9', requestId: 'SAMPLE-1' }));
});
