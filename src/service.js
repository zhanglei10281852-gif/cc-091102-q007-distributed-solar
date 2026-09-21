import { requestStates, canTransition, findTopicOverlap } from './domain.js';
import { ServiceError, errorCodes } from './errors.js';
import { roles } from './context.js';

export { ServiceError, errorCodes };

// 越权与不存在共用同一句文案，调用方无法从错误响应推断其他县域是否存在对象。
const NOT_FOUND_MESSAGE = '对象不存在或不在可见范围内';
const FORBIDDEN_MESSAGE = '当前角色无权执行该操作';

export function createService({ store, cache, audit, now = () => new Date().toISOString() }) {
  const scopedKeyOf = (scope, requestId) =>
    JSON.stringify([scope.tenant, scope.operator, scope.site, requestId]);

  function auditDeny(actor, action, detail = {}) {
    audit.record({
      actor: actor?.id ?? 'anonymous',
      role: actor?.role ?? 'unknown',
      tenant: actor?.tenant ?? null,
      action,
      decision: 'deny',
      ...detail,
    });
  }

  function forbid(actor, action, reason) {
    auditDeny(actor, action, { reason });
    throw new ServiceError(errorCodes.FORBIDDEN, FORBIDDEN_MESSAGE);
  }

  function notFound(actor, action, probe = null) {
    if (probe) auditDeny(actor, action, probe);
    throw new ServiceError(errorCodes.NOT_FOUND, NOT_FOUND_MESSAGE);
  }

  function requireActor(actor) {
    if (!actor) throw new ServiceError(errorCodes.UNAUTHENTICATED, '缺少访问者身份');
  }

  // 解析县级作用域：县域强制取访问者绑定值；声明他县（或越出绑定运营商）
  // 即视为越权探测，按"不存在"统一处理并落审计。
  function requireCountyScope(actor, requested, action) {
    requireActor(actor);
    if (actor.role === roles.PROVINCE_ADMIN) forbid(actor, action, 'province-admin-detail-access');
    if (actor.role !== roles.COUNTY_USER) forbid(actor, action, 'unknown-role');
    if (requested?.tenant != null && requested.tenant !== actor.tenant) {
      notFound(actor, action, { reason: 'cross-tenant-scope', requestedTenant: requested.tenant });
    }
    if (actor.operator && requested?.operator != null && requested.operator !== actor.operator) {
      notFound(actor, action, { reason: 'cross-operator-scope', requestedOperator: requested.operator });
    }
    return {
      tenant: actor.tenant,
      operator: actor.operator ?? requested?.operator ?? null,
      site: requested?.site ?? null,
    };
  }

  function requireScopeFields(scope) {
    if (!scope.operator || !scope.site) {
      throw new ServiceError(errorCodes.VALIDATION, '作用域必须包含运营商与脱敏站点');
    }
  }

  // 读取：先查作用域缓存再回落存储；未命中时若申请号存在于其他县域，
  // 记越权探测审计——响应与"不存在"完全一致。
  function loadRecord(actor, ref, action) {
    const scope = requireCountyScope(actor, ref, action);
    requireScopeFields(scope);
    const requestId = ref?.requestId;
    if (!requestId) throw new ServiceError(errorCodes.VALIDATION, '缺少申请号');
    const cached = cache.get(scope, requestId);
    if (cached) return { scope, record: cached };
    const record = store.get(scope, requestId);
    if (record) {
      cache.set(scope, requestId, record);
      return { scope, record };
    }
    if (store.existsInOtherTenant(scope.tenant, requestId)) {
      notFound(actor, action, { reason: 'cross-tenant-probe', requestId });
    }
    notFound(actor, action);
  }

  function assertTransition(record, to) {
    if (!canTransition(record.state, to)) {
      throw new ServiceError(errorCodes.INVALID_STATE, `状态 ${record.state} 不可迁移到 ${to}`);
    }
  }

  function commitTransition(record, scope, actor, to, extra = {}) {
    const from = record.state;
    record.state = to;
    record.updatedAt = now();
    record.history.push({ from, to, at: record.updatedAt, actor: actor.id, ...extra });
    cache.set(scope, record.requestId, record);
  }

  function toPublic(record) {
    return {
      tenant: record.tenant,
      operator: record.operator,
      site: record.site,
      requestId: record.requestId,
      state: record.state,
      topicCodes: [...record.topicCodes],
      window: record.window ? { ...record.window } : null,
      negotiation: record.negotiation
        ? { at: record.negotiation.at, overlaps: record.negotiation.overlaps.map(item => ({ ...item })) }
        : null,
      history: record.history.map(entry => ({ ...entry })),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function normalizeTopicCodes(topicCodes) {
    if (topicCodes == null) return [];
    if (!Array.isArray(topicCodes) || topicCodes.some(code => typeof code !== 'string' || !code)) {
      throw new ServiceError(errorCodes.VALIDATION, '主题编码必须为非空字符串数组');
    }
    return [...new Set(topicCodes)];
  }

  // 县级统计与省级聚合共用同一计算，输出只含计数与窗口水位，
  // 不含任何户用站点标识与申请号。
  function computeTenantStats(tenant) {
    const byState = Object.fromEntries(requestStates.map(state => [state, 0]));
    let total = 0;
    for (const record of store.listByTenant(tenant)) {
      byState[record.state] += 1;
      total += 1;
    }
    const windows = {};
    for (const [windowId, window] of store.windowsFor(tenant)) {
      windows[windowId] = {
        capacity: window.capacity,
        held: window.holds.size,
        remaining: window.capacity - window.holds.size,
      };
    }
    return { tenant, total, byState, windows };
  }

  return {
    // 申请：县级用户在本域作用域下创建，同作用域申请号冲突才报 CONFLICT。
    apply(actor, input = {}) {
      const scope = requireCountyScope(actor, input, 'apply');
      requireScopeFields(scope);
      const requestId = input.requestId;
      if (!requestId || typeof requestId !== 'string') {
        throw new ServiceError(errorCodes.VALIDATION, '缺少申请号');
      }
      const topicCodes = normalizeTopicCodes(input.topicCodes);
      if (store.get(scope, requestId)) {
        throw new ServiceError(errorCodes.CONFLICT, '申请号在当前作用域已存在');
      }
      const at = now();
      const record = {
        tenant: scope.tenant,
        operator: scope.operator,
        site: scope.site,
        requestId,
        topicCodes,
        state: 'submitted',
        window: null,
        negotiation: null,
        history: [{ from: null, to: 'submitted', at, actor: actor.id }],
        createdAt: at,
        updatedAt: at,
      };
      store.put(record);
      cache.set(scope, requestId, record);
      return toPublic(record);
    },

    // 主题重合协商：重合集只在本县域内计算，检查计划绝不跨县合并。
    negotiate(actor, ref = {}) {
      const { scope, record } = loadRecord(actor, ref, 'negotiate');
      assertTransition(record, 'negotiating');
      const selfKey = scopedKeyOf(scope, record.requestId);
      const overlaps = findTopicOverlap(
        store
          .listByTenant(scope.tenant)
          .filter(item => scopedKeyOf(item, item.requestId) !== selfKey && item.state !== 'cancelled'),
        record.topicCodes,
      ).map(item => ({ operator: item.operator, site: item.site, requestId: item.requestId, state: item.state }));
      commitTransition(record, scope, actor, 'negotiating');
      record.negotiation = { at: record.updatedAt, overlaps };
      cache.set(scope, record.requestId, record);
      return toPublic(record);
    },

    // 窗口锁定：容量按县域独立扣减。
    holdWindow(actor, ref = {}, windowId) {
      const { scope, record } = loadRecord(actor, ref, 'hold-window');
      if (!windowId || typeof windowId !== 'string') {
        throw new ServiceError(errorCodes.VALIDATION, '缺少检查窗口');
      }
      assertTransition(record, 'window-held');
      store.holdWindow(scope.tenant, windowId, scopedKeyOf(scope, record.requestId));
      commitTransition(record, scope, actor, 'window-held', { windowId });
      record.window = { windowId, heldAt: record.updatedAt };
      cache.set(scope, record.requestId, record);
      return toPublic(record);
    },

    approve(actor, ref = {}) {
      const { scope, record } = loadRecord(actor, ref, 'approve');
      assertTransition(record, 'approved');
      commitTransition(record, scope, actor, 'approved');
      return toPublic(record);
    },

    // 取消：释放已锁窗口容量；终止态不可再迁移。
    cancel(actor, ref = {}) {
      const { scope, record } = loadRecord(actor, ref, 'cancel');
      assertTransition(record, 'cancelled');
      if (record.window) {
        store.releaseWindow(scope.tenant, record.window.windowId, scopedKeyOf(scope, record.requestId));
      }
      commitTransition(record, scope, actor, 'cancelled');
      if (record.window) {
        record.window = { ...record.window, releasedAt: record.updatedAt };
        cache.set(scope, record.requestId, record);
      }
      return toPublic(record);
    },

    getRequest(actor, ref = {}) {
      return toPublic(loadRecord(actor, ref, 'read').record);
    },

    listRequests(actor, requestedTenant = null) {
      const scope = requireCountyScope(actor, { tenant: requestedTenant }, 'list');
      return store
        .listByTenant(scope.tenant)
        .map(toPublic)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId));
    },

    tenantStats(actor, requestedTenant = null) {
      const scope = requireCountyScope(actor, { tenant: requestedTenant }, 'stats');
      return computeTenantStats(scope.tenant);
    },

    // 省级聚合：只含各县域计数与窗口水位，省级管理员无法据此触达任何明细。
    aggregate(actor) {
      requireActor(actor);
      if (actor.role !== roles.PROVINCE_ADMIN) forbid(actor, 'aggregate', 'county-user-aggregate');
      const tenants = {};
      const totals = { total: 0, byState: Object.fromEntries(requestStates.map(state => [state, 0])) };
      for (const tenant of store.listTenants()) {
        const stats = computeTenantStats(tenant);
        tenants[tenant] = stats;
        totals.total += stats.total;
        for (const state of requestStates) totals.byState[state] += stats.byState[state];
      }
      return { tenants, totals };
    },

    // 检查窗口为平台级配置，仅省级管理员可定义；容量按县域各自独立。
    defineWindow(actor, { tenant, windowId, capacity } = {}) {
      requireActor(actor);
      if (actor.role !== roles.PROVINCE_ADMIN) forbid(actor, 'define-window', 'county-user-define-window');
      if (!tenant || !windowId || !Number.isInteger(capacity) || capacity < 1) {
        throw new ServiceError(errorCodes.VALIDATION, '窗口配置需要县域、窗口标识与正整数容量');
      }
      store.defineWindow(tenant, windowId, capacity);
      return { tenant, windowId, capacity };
    },
  };
}
