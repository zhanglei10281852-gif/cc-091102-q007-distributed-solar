/**
 * 抽检申请领域服务。
 *
 * 作用域规则（所有读取与状态变更的共同前提）：
 *  1. 明细只能由本县主体访问；省级账号访问明细一律按“不存在”处理并审计。
 *  2. 主题重合协商、窗口容量、站点冲突全部限定在同一租户内计算——
 *     两个县并行处理相同申请号时，容量与状态链互不影响。
 *  3. 省级统计仅按县返回聚合计数，不包含任何申请号/站点编号等明细标识。
 *
 * 状态链：
 *   submitted ──negotiate──▶ negotiating ──lockWindow──▶ window-held ──approve──▶ approved
 *      └──────────── 以上任一活动状态均可 cancel ────────────▶ cancelled
 *   window-held 超过 heldUntil 未确认：惰性过期回退 negotiating，释放容量。
 */
import { ConflictError, NotFoundError } from './errors.js';
import { guardDetailAccess, guardWrite, ROLES } from './auth.js';
import { intervalsOverlap } from './scope.js';

export const requestStates = ['submitted', 'negotiating', 'window-held', 'approved', 'cancelled'];

const WINDOW_OCCUPYING = new Set(['window-held', 'approved']);
const DEFAULT_WINDOW_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TENANT_CAPACITY = 2;

export class SamplingService {
  #store;
  #auth;
  #clock;
  #windowTtlMs;
  #capacities = new Map(); // tenant -> 并发窗口容量

  constructor(store, auth, { clock = () => Date.now(), windowTtlMs = DEFAULT_WINDOW_TTL_MS, capacities = {} } = {}) {
    this.#store = store;
    this.#auth = auth;
    this.#clock = clock;
    this.#windowTtlMs = windowTtlMs;
    for (const [tenant, cap] of Object.entries(capacities)) this.#capacities.set(tenant, cap);
  }

  #capacityFor(tenant) {
    return this.#capacities.get(tenant) ?? DEFAULT_TENANT_CAPACITY;
  }

  /** 惰性过期：窗口持锁超时则回退 negotiating 并释放占用，返回最新记录。 */
  #materialize(record) {
    const now = this.#clock();
    if (record.state === 'window-held' && Date.parse(record.heldUntil) <= now) {
      const lapsed = this.#store.update(record.tenant, record.requestId, record.version, () => ({
        state: 'negotiating',
        window: null,
        heldUntil: null,
        history: [...record.history, { at: new Date(now).toISOString(), transition: 'hold-expired' }],
      }));
      if (lapsed) return lapsed;
      const reloaded = this.#store.loadVersioned(record.tenant, record.requestId);
      return reloaded ? reloaded.record : record;
    }
    return record;
  }

  #loadInTenant(principal, requestId) {
    // 租户来自已认证主体，而非请求参数：调用方无法指定别的县。
    const tenant = principal.tenant;
    guardDetailAccess(this.#auth, principal, tenant, requestId, 'read');
    const versioned = this.#store.loadVersioned(tenant, requestId);
    if (!versioned) throw new NotFoundError();
    return this.#materialize(versioned.record);
  }

  /**
   * 创建申请。tenant 永远取主体所属租户；operator 在运营商账号下也强制取主体自身，
   * 防止伪造属主。同租户内 requestId 重复返回 409；跨县同号互不影响。
   */
  createRequest(principal, input) {
    if (principal.role === ROLES.PROVINCE) {
      this.#auth.audit.crossScopeAttempt(principal, {
        tenant: null,
        requestId: input?.requestId ?? null,
        action: 'create',
        reason: 'province-write',
      });
      throw new NotFoundError();
    }
    const tenant = principal.tenant;
    // 载荷可能携带租户字段（批量导入/合并的常见错误来源）；与主体不一致即越权，
    // 按 404 处理并审计，绝不静默改写到主体租户，也不返回 403 泄露对方租户存在性。
    if (input?.tenant != null && String(input.tenant) !== tenant) {
      this.#auth.audit.crossScopeAttempt(principal, {
        tenant: String(input.tenant),
        requestId: input?.requestId ?? null,
        action: 'create',
        reason: 'payload-tenant-mismatch',
      });
      throw new NotFoundError();
    }
    const requestId = String(input?.requestId ?? '').trim();
    const siteRef = String(input?.siteRef ?? '').trim();
    const topicCodes = Array.isArray(input?.topicCodes)
      ? input.topicCodes.map((c) => String(c)).filter(Boolean)
      : [];
    if (!requestId) throw new ConflictError('requestId is required', 'validation-failed');
    if (!siteRef) throw new ConflictError('siteRef is required', 'validation-failed');

    const operator =
      principal.role === ROLES.OPERATOR
        ? principal.operator
        : String(input?.operator ?? '').trim() || principal.operator;
    if (!operator) throw new ConflictError('operator is required', 'validation-failed');

    const now = new Date(this.#clock()).toISOString();
    const record = {
      tenant,
      requestId,
      operator,
      siteRef,
      topicCodes,
      state: 'submitted',
      window: null,
      heldUntil: null,
      createdAt: now,
      history: [{ at: now, transition: 'created', by: principal.id }],
    };
    if (!this.#store.insert(record)) {
      // 同租户重复 = 409；注意此处主体已在本县，不存在跨县存在性探测面。
      throw new ConflictError('requestId already exists in this tenant', 'duplicate-request');
    }
    return this.toView(principal, record);
  }

  getRequest(principal, requestId) {
    const tenant = principal.tenant;
    guardDetailAccess(this.#auth, principal, tenant, requestId, 'read');
    const versioned = this.#store.loadVersioned(tenant, requestId);
    if (!versioned) throw new NotFoundError();
    const record = this.#materialize(versioned.record);

    // 缓存只可能在“作用域守卫已通过 + 版本号一致”时命中；
    // 复合键带租户，跨县同号永远不会命中对方的缓存条目。
    const cached = this.#store.readViewCache(tenant, requestId, record.version);
    if (cached) return cached;

    const view = this.toView(principal, record);
    this.#store.writeViewCache(tenant, requestId, record.version, view);
    return view;
  }

  listRequests(principal) {
    if (principal.role === ROLES.PROVINCE) {
      this.#auth.audit.crossScopeAttempt(principal, {
        tenant: null,
        requestId: null,
        action: 'list-detail',
        reason: 'province-detail-access',
      });
      throw new NotFoundError();
    }
    guardDetailAccess(this.#auth, principal, principal.tenant, null, 'list');
    let records = this.#store.list(principal.tenant).map((r) => this.#materialize(r));
    if (principal.role === ROLES.OPERATOR) {
      records = records.filter((r) => r.operator === principal.operator);
    }
    return records.map((r) => this.toView(principal, r));
  }

  /**
   * 主题重合协商：仅在同租户、活动中的其他申请间计算重合主题。
   * 返回协商对象（不含其他申请的站点标识，只给申请号与重合编码）。
   */
  negotiate(principal, requestId) {
    let record = this.#loadInTenant(principal, requestId);
    guardWrite(this.#auth, principal, record, 'negotiate');
    if (!['submitted', 'negotiating'].includes(record.state)) {
      throw new ConflictError(`cannot negotiate from ${record.state}`, 'invalid-transition');
    }

    const peers = this.#store
      .list(record.tenant)
      .map((r) => this.#materialize(r))
      .filter(
        (r) =>
          r.requestId !== record.requestId &&
          r.state !== 'cancelled' &&
          r.topicCodes.some((code) => record.topicCodes.includes(code)),
      );

    const overlaps = peers.map((r) => ({
      requestId: r.requestId,
      operator: r.operator,
      sharedTopicCodes: r.topicCodes.filter((code) => record.topicCodes.includes(code)),
    }));

    record =
      this.#store.update(record.tenant, record.requestId, record.version, (cur) => ({
        state: 'negotiating',
        overlapRequestIds: overlaps.map((o) => o.requestId),
        history: [
          ...cur.history,
          {
            at: new Date(this.#clock()).toISOString(),
            transition: 'negotiating',
            by: principal.id,
            peers: overlaps.length,
          },
        ],
      })) ?? record;

    return { ...this.toView(principal, record), topicOverlaps: overlaps };
  }

  /**
   * 锁定检查窗口。容量与站点冲突均只在本租户内判定，因此双县同号互不影响：
   *  - 容量：与申请窗口重叠的 held/approved 窗口数达到本县上限时拒绝。
   *  - 同站点：同租户内相同脱敏站点编号不得持有时间重叠的窗口。
   */
  lockWindow(principal, requestId, { start, end } = {}) {
    let record = this.#loadInTenant(principal, requestId);
    guardWrite(this.#auth, principal, record, 'lock-window');
    if (!['submitted', 'negotiating'].includes(record.state)) {
      throw new ConflictError(`cannot lock window from ${record.state}`, 'invalid-transition');
    }
    const startTime = Date.parse(start);
    const endTime = Date.parse(end);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      throw new ConflictError('window requires valid start < end', 'validation-failed');
    }
    const window = { start: new Date(startTime).toISOString(), end: new Date(endTime).toISOString() };

    const occupying = this.#store
      .list(record.tenant)
      .map((r) => this.#materialize(r))
      .filter((r) => r.requestId !== record.requestId && WINDOW_OCCUPYING.has(r.state) && r.window);

    const overlapping = occupying.filter((r) => intervalsOverlap(
      { start: Date.parse(r.window.start), end: Date.parse(r.window.end) },
      { start: startTime, end: endTime },
    ));
    if (overlapping.some((r) => r.siteRef === record.siteRef)) {
      throw new ConflictError('site already has an overlapping window', 'site-window-conflict');
    }
    if (overlapping.length >= this.#capacityFor(record.tenant)) {
      throw new ConflictError('tenant window capacity exceeded', 'capacity-exceeded');
    }

    const now = this.#clock();
    const updated = this.#store.update(record.tenant, record.requestId, record.version, (cur) => ({
      state: 'window-held',
      window,
      heldUntil: new Date(now + this.#windowTtlMs).toISOString(),
      history: [
        ...cur.history,
        { at: new Date(now).toISOString(), transition: 'window-held', by: principal.id },
      ],
    }));
    if (!updated) throw new ConflictError('concurrent update, retry', 'concurrent-modification');
    return this.toView(principal, updated);
  }

  approve(principal, requestId) {
    let record = this.#loadInTenant(principal, requestId);
    guardWrite(this.#auth, principal, record, 'approve');
    if (record.state !== 'window-held') {
      throw new ConflictError(`cannot approve from ${record.state}`, 'invalid-transition');
    }
    const updated = this.#store.update(record.tenant, record.requestId, record.version, (cur) => ({
      state: 'approved',
      heldUntil: null,
      history: [
        ...cur.history,
        { at: new Date(this.#clock()).toISOString(), transition: 'approved', by: principal.id },
      ],
    }));
    if (!updated) throw new ConflictError('concurrent update, retry', 'concurrent-modification');
    return this.toView(principal, updated);
  }

  cancel(principal, requestId, { reason = '' } = {}) {
    let record = this.#loadInTenant(principal, requestId);
    guardWrite(this.#auth, principal, record, 'cancel');
    if (record.state === 'cancelled') {
      throw new ConflictError('already cancelled', 'invalid-transition');
    }
    if (record.state === 'approved') {
      throw new ConflictError('approved requests cannot be cancelled', 'invalid-transition');
    }
    const updated = this.#store.update(record.tenant, record.requestId, record.version, (cur) => ({
      state: 'cancelled',
      window: null,
      heldUntil: null,
      cancelReason: reason || cur.cancelReason || null,
      history: [
        ...cur.history,
        { at: new Date(this.#clock()).toISOString(), transition: 'cancelled', by: principal.id },
      ],
    }));
    if (!updated) throw new ConflictError('concurrent update, retry', 'concurrent-modification');
    return this.toView(principal, updated);
  }

  /**
   * 统计。
   *  - 县级主体：仅本租户计数；运营商进一步限定本人属主。
   *  - 省级主体：跨县聚合，输出按县的状态计数——只有数字和县编码，
   *    不含 requestId/siteRef/operator，无法据此推断某户用站点是否存在。
   */
  stats(principal) {
    const byState = () => {
      const counts = Object.fromEntries(requestStates.map((s) => [s, 0]));
      return counts;
    };

    if (principal.role === ROLES.PROVINCE) {
      const tenants = {};
      for (const raw of this.#store.list()) {
        const r = this.#materialize(raw);
        if (!tenants[r.tenant]) tenants[r.tenant] = { total: 0, byState: byState() };
        tenants[r.tenant].total += 1;
        tenants[r.tenant].byState[r.state] += 1;
      }
      return { scope: 'province', tenants };
    }

    if (!this.#auth.canReadTenantAggregate(principal, principal.tenant)) {
      this.#auth.audit.crossScopeAttempt(principal, {
        tenant: principal.tenant,
        action: 'stats',
        reason: 'tenant-mismatch',
      });
      throw new NotFoundError();
    }
    let records = this.#store.list(principal.tenant).map((r) => this.#materialize(r));
    if (principal.role === ROLES.OPERATOR) {
      records = records.filter((r) => r.operator === principal.operator);
    }
    const result = { scope: 'tenant', tenant: principal.tenant, total: records.length, byState: byState() };
    for (const r of records) result.byState[r.state] += 1;
    return result;
  }

  /**
   * 脱敏视图：剥离内部版本字段。库内 siteRef 本身即脱敏站点编号（如 HA-7），
   * 明细路径不会再额外加工；真正的保护在于该视图只能通过已校验租户边界的路径获得。
   */
  toView(principal, record) {
    const { version, history, ...rest } = record;
    return { ...rest };
  }
}
