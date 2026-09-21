import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requestStates,
  requestTransitions,
  canTransition,
  cacheRequest,
  getRequest,
  findTopicOverlap,
} from '../src/domain.js';

test('状态链覆盖全部状态且终止态不可再迁移', () => {
  for (const state of requestStates) assert.ok(state in requestTransitions);
  assert.deepEqual(requestTransitions.approved, []);
  assert.deepEqual(requestTransitions.cancelled, []);
  assert.ok(canTransition('submitted', 'negotiating'));
  assert.ok(canTransition('negotiating', 'window-held'));
  assert.ok(canTransition('window-held', 'approved'));
  assert.ok(!canTransition('submitted', 'approved'));
  assert.ok(!canTransition('approved', 'cancelled'));
});

test('作用域缓存不会因相同申请号跨县命中', () => {
  const recordA = { tenant: 'county-a', operator: 'op', site: 'HA-7', requestId: 'SAMPLE-C1', state: 'submitted' };
  assert.equal(cacheRequest(recordA), true);
  assert.equal(getRequest({ tenant: 'county-a', operator: 'op', site: 'HA-7' }, 'SAMPLE-C1'), recordA);
  // 相同申请号在邻县、邻站、缺作用域时一律落空
  assert.equal(getRequest({ tenant: 'county-b', operator: 'op', site: 'HA-7' }, 'SAMPLE-C1'), null);
  assert.equal(getRequest({ tenant: 'county-a', operator: 'op', site: 'HB-9' }, 'SAMPLE-C1'), null);
  assert.equal(getRequest({ tenant: 'county-a' }, 'SAMPLE-C1'), null);
  // 缺少作用域字段的记录拒绝写入
  assert.equal(cacheRequest({ requestId: 'SAMPLE-C2' }), false);
});

test('主题重合为纯函数过滤', () => {
  const items = [{ topicCodes: ['a', 'b'] }, { topicCodes: ['c'] }, {}];
  assert.deepEqual(findTopicOverlap(items, ['b']), [items[0]]);
  assert.deepEqual(findTopicOverlap(items, ['x']), []);
});
