import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createService, ServiceError } from './service.js';
import { createStore } from './store.js';
import { createScopedCache } from './cache.js';
import { createAuditStream } from './audit.js';
import { createActor } from './context.js';
import { errorCodes } from './errors.js';

// 既有状态接口负载，保持不变。
const STATUS_PAYLOAD = { service: 'distributed-solar-sampling', status: 'running' };

const httpStatusByCode = {
  [errorCodes.UNAUTHENTICATED]: 401,
  [errorCodes.FORBIDDEN]: 403,
  [errorCodes.NOT_FOUND]: 404,
  [errorCodes.CONFLICT]: 409,
  [errorCodes.INVALID_STATE]: 409,
  [errorCodes.WINDOW_UNKNOWN]: 404,
  [errorCodes.WINDOW_FULL]: 409,
  [errorCodes.VALIDATION]: 400,
};

export function createPlatform(overrides = {}) {
  const store = overrides.store ?? createStore();
  const cache = overrides.cache ?? createScopedCache();
  const audit = overrides.audit ?? createAuditStream();
  const service = overrides.service ?? createService({ store, cache, audit });
  return { store, cache, audit, service };
}

// 身份经请求头传播：x-actor-id / x-actor-role / x-actor-tenant / x-actor-operator。
function actorFromHeaders(headers) {
  const id = headers['x-actor-id'];
  const role = headers['x-actor-role'];
  if (!id || !role) return null;
  try {
    return createActor({
      id,
      role,
      tenant: headers['x-actor-tenant'] || null,
      operator: headers['x-actor-operator'] || null,
    });
  } catch {
    return null;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new ServiceError(errorCodes.VALIDATION, '请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ServiceError(errorCodes.VALIDATION, '请求体不是合法 JSON'));
      }
    });
    request.on('error', reject);
  });
}

export function createApp(platform = createPlatform()) {
  const { service } = platform;

  return async function handle(request, response) {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };

    const segments = new URL(request.url, 'http://localhost').pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);

    try {
      // 状态接口：沿用既有探活负载，无需身份。
      if (request.method === 'GET' && segments.length === 0) {
        return send(200, STATUS_PAYLOAD);
      }

      const actor = actorFromHeaders(request.headers);
      if (!actor) {
        return send(401, { error: { code: errorCodes.UNAUTHENTICATED, message: '缺少有效的访问者身份' } });
      }

      const [head, ...rest] = segments;

      if (head === 'requests') {
        if (request.method === 'POST' && rest.length === 0) {
          const body = await readBody(request);
          return send(201, { request: service.apply(actor, body) });
        }
        if (rest.length === 4 || rest.length === 5) {
          const [tenant, operator, site, requestId, verb] = rest;
          const ref = { tenant, operator, site, requestId };
          if (request.method === 'GET' && rest.length === 4) {
            return send(200, { request: service.getRequest(actor, ref) });
          }
          if (request.method === 'POST' && rest.length === 5) {
            if (verb === 'negotiate') return send(200, { request: service.negotiate(actor, ref) });
            if (verb === 'approve') return send(200, { request: service.approve(actor, ref) });
            if (verb === 'cancel') return send(200, { request: service.cancel(actor, ref) });
            if (verb === 'hold-window') {
              const body = await readBody(request);
              return send(200, { request: service.holdWindow(actor, ref, body.windowId) });
            }
          }
        }
      }

      if (head === 'tenants' && rest.length === 2 && request.method === 'GET') {
        const [tenant, view] = rest;
        if (view === 'requests') return send(200, { requests: service.listRequests(actor, tenant) });
        if (view === 'stats') return send(200, { stats: service.tenantStats(actor, tenant) });
      }

      if (head === 'aggregate' && rest.length === 0 && request.method === 'GET') {
        return send(200, { aggregate: service.aggregate(actor) });
      }

      if (head === 'windows' && rest.length === 0 && request.method === 'POST') {
        const body = await readBody(request);
        return send(201, { window: service.defineWindow(actor, body) });
      }

      return send(404, { error: { code: errorCodes.NOT_FOUND, message: '资源不存在' } });
    } catch (error) {
      if (error instanceof ServiceError) {
        const status = httpStatusByCode[error.code] ?? 500;
        return send(status, { error: { code: error.code, message: error.message } });
      }
      return send(500, { error: { code: 'INTERNAL', message: '服务内部错误' } });
    }
  };
}

export function startServer(port = Number(process.env.PORT || 8080)) {
  const platform = createPlatform();
  const server = createServer(createApp(platform));
  server.listen(port);
  return { server, platform };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
