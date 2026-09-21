/**
 * 鉴权与审计。
 *
 * 角色模型：
 *  - province（省级管理员）：可读跨县聚合；不得读/写任何明细，也不能借明细接口探测对象是否存在。
 *  - county-admin（县级管理员）：仅本租户明细读写与本域统计。
 *  - operator（运营商账号）：仅本租户、且 operator 为本主体的记录。
 *
 * 令牌表运行期注入（实际访问令牌不得入库）。所有拒绝——尤其是跨租户探测——
 * 都会进入审计流，且对外与“对象不存在”不可区分。
 */
import { randomUUID } from 'node:crypto';
import { AuthenticationError, AuthorizationError, NotFoundError } from './errors.js';

export const ROLES = {
  PROVINCE: 'province',
  COUNTY_ADMIN: 'county-admin',
  OPERATOR: 'operator',
};

export class AuthService {
  #tokens = new Map(); // token -> principal
  audit;

  constructor(audit) {
    this.audit = audit;
  }

  /** 登记一个长期令牌；测试/启动引导使用，生产应由密钥管理注入。 */
  issue(principal, token = randomUUID()) {
    this.#tokens.set(token, principal);
    return token;
  }

  authenticate(token) {
    const principal = token ? this.#tokens.get(token) : undefined;
    if (!principal) {
      this.audit.record({ event: 'authenticate-failed', result: 'denied', reason: 'invalid-token' });
      throw new AuthenticationError();
    }
    return principal;
  }

  /** 明细读取是否落在主体作用域内。省级账号对任何明细都返回 false。 */
  canReadDetail(principal, tenant) {
    if (principal.role === ROLES.PROVINCE) return false;
    return principal.tenant === tenant;
  }

  /** 状态变更权限：仅本租户的县级/运营商主体，且运营商只能操作自己的记录。 */
  canWrite(principal, record) {
    if (principal.role === ROLES.PROVINCE) return false;
    if (principal.tenant !== record.tenant) return false;
    if (principal.role === ROLES.OPERATOR && principal.operator !== record.operator) return false;
    return true;
  }

  canReadCrossTenantAggregate(principal) {
    return principal.role === ROLES.PROVINCE;
  }

  canReadTenantAggregate(principal, tenant) {
    if (principal.role === ROLES.PROVINCE) return true;
    return principal.tenant === tenant;
  }
}

/**
 * 越权尝试审计流。内存环形缓冲 + 可选外部 sink（例如日志/安全平台）。
 * 审计条目保留足够排障信息：谁在何时探测了哪个租户边界。
 */
export class AuditLog {
  #entries = [];
  #limit;
  #sink;

  constructor({ limit = 1000, sink = null } = {}) {
    this.#limit = limit;
    this.#sink = sink;
  }

  record(entry) {
    const item = { time: new Date().toISOString(), ...entry };
    this.#entries.push(item);
    if (this.#entries.length > this.#limit) this.#entries.shift();
    if (this.#sink) {
      try {
        this.#sink(item);
      } catch {
        /* sink 失败不能影响业务路径 */
      }
    }
    return item;
  }

  /** 审计查询本身也受限：返回条目副本，避免调用方持有内部引用。 */
  list(predicate = null) {
    const data = predicate ? this.#entries.filter(predicate) : this.#entries.slice();
    return data.map((e) => ({ ...e }));
  }

  /** 统一记录“作用域越界/探测”尝试。 */
  crossScopeAttempt(principal, { tenant, requestId, action, reason }) {
    return this.record({
      event: 'cross-scope-attempt',
      result: 'denied',
      principalId: principal?.id ?? null,
      role: principal?.role ?? null,
      principalTenant: principal?.tenant ?? null,
      targetTenant: tenant ?? null,
      requestId: requestId ?? null,
      action,
      reason,
    });
  }
}

/**
 * 明细访问守卫：主体无权读取该租户时，记审计并返回 404。
 * 注意：这里故意抛 NotFoundError 而非 403——让跨县探测与“编号不存在”无法区分，
 * 调用方无法从状态码或响应体推断其他县是否存在该对象。
 */
export function guardDetailAccess(auth, principal, tenant, requestId, action) {
  if (!auth.canReadDetail(principal, tenant)) {
    auth.audit.crossScopeAttempt(principal, {
      tenant,
      requestId,
      action,
      reason: principal.role === ROLES.PROVINCE ? 'province-detail-access' : 'tenant-mismatch',
    });
    throw new NotFoundError();
  }
}

/**
 * 写权限守卫分两步：先过租户边界（失败按 404 处理并审计），
 * 再校验记录级属主（同租户内无权属主返回 403，此时不存在存在性泄露）。
 */
export function guardWrite(auth, principal, record, action) {
  if (principal.tenant !== record.tenant || principal.role === ROLES.PROVINCE) {
    auth.audit.crossScopeAttempt(principal, {
      tenant: record.tenant,
      requestId: record.requestId,
      action,
      reason: principal.role === ROLES.PROVINCE ? 'province-write' : 'tenant-mismatch',
    });
    throw new NotFoundError();
  }
  if (!auth.canWrite(principal, record)) {
    auth.audit.record({
      event: 'authorization-denied',
      result: 'denied',
      principalId: principal.id,
      role: principal.role,
      targetTenant: record.tenant,
      requestId: record.requestId,
      action,
      reason: 'operator-not-owner',
    });
    throw new AuthorizationError();
  }
}
