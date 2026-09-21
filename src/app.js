/**
 * HTTP 应用装配与路由。鉴权主体的租户永远来自令牌，不接受请求参数指定租户。
 */
import { AuthService, AuditLog, ROLES } from './auth.js';
import { ScopedStore } from './store.js';
import { SamplingService } from './service.js';
import { DomainError, NotFoundError, AuthorizationError } from './errors.js';

export function createApp({ auditSink = null, clock, windowTtlMs, capacities, tokens = {} } = {}) {
  const audit = new AuditLog({ sink: auditSink });
  const auth = new AuthService(audit);
  const store = new ScopedStore();
  const service = new SamplingService(store, auth, { clock, windowTtlMs, capacities });

  for (const [token, principal] of Object.entries(tokens)) auth.issue(principal, token);

  function sendError(res, error) {
    const status = error instanceof DomainError ? error.status : 500;
    const code = error instanceof DomainError ? error.code : 'internal-error';
    // 统一错误外形：跨县探测与真正不存在得到逐字节同构的响应。
    const body = { error: { code } };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new DomainError('invalid json', { status: 400, code: 'invalid-json' });
    }
  }

  function principalFrom(req) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    return auth.authenticate(token);
  }

  /** 路由 [method, pattern]，pattern 段以 : 开头为参数；租户主键一律不取自从 URL。 */
  const routes = [
    ['POST', /^\/requests$/, (p, body) => ({ data: service.createRequest(p, body), status: 201 })],
    ['GET', /^\/requests$/, (p) => ({ data: { requests: service.listRequests(p) } })],
    ['GET', /^\/requests\/([^/]+)$/, (p, _b, m) => ({ data: service.getRequest(p, decodeURIComponent(m[1])) })],
    ['POST', /^\/requests\/([^/]+)\/negotiate$/, (p, _b, m) => ({ data: service.negotiate(p, decodeURIComponent(m[1])) })],
    ['POST', /^\/requests\/([^/]+)\/lock-window$/, (p, body, m) => ({
      data: service.lockWindow(p, decodeURIComponent(m[1]), body),
    })],
    ['POST', /^\/requests\/([^/]+)\/approve$/, (p, _b, m) => ({ data: service.approve(p, decodeURIComponent(m[1])) })],
    ['POST', /^\/requests\/([^/]+)\/cancel$/, (p, body, m) => ({
      data: service.cancel(p, decodeURIComponent(m[1]), body ?? {}),
    })],
    ['GET', /^\/stats$/, (p) => ({ data: service.stats(p) })],
    ['GET', /^\/audit$/, (p) => {
      // 审计流仅省级安全视角可读；其他角色按 404 处理，不暴露审计端点存在性。
      if (p.role !== ROLES.PROVINCE) {
        audit.crossScopeAttempt(p, { tenant: p.tenant ?? null, action: 'audit-read', reason: 'audit-denied' });
        throw new NotFoundError();
      }
      return { data: { entries: audit.list() } };
    }],
  ];

  async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    try {
      const principal = principalFrom(req);
      const path = url.pathname;
      for (const [method, pattern, handle] of routes) {
        if (req.method !== method) continue;
        const match = path.match(pattern);
        if (!match) continue;
        const body = method === 'POST' ? await readJson(req) : null;
        const { status = 200, data } = handle(principal, body, match);
        return sendJson(res, status, data);
      }
      return sendError(res, new NotFoundError('route not found'));
    } catch (error) {
      if (!(error instanceof DomainError)) {
        audit.record({
          event: 'internal-error',
          result: 'error',
          path: url.pathname,
          message: String(error?.message ?? error).slice(0, 200),
        });
      }
      return sendError(res, error);
    }
  }

  return { handler, service, auth, audit, store };
}
