import { createScopedCache } from './cache.js';

// 状态常量：仓库既有定义，继续作为唯一状态链来源。
export const requestStates = ['submitted', 'negotiating', 'window-held', 'approved', 'cancelled'];

// 状态迁移表：approved / cancelled 为终止态。
export const requestTransitions = Object.freeze({
  submitted: Object.freeze(['negotiating', 'cancelled']),
  negotiating: Object.freeze(['window-held', 'cancelled']),
  'window-held': Object.freeze(['approved', 'cancelled']),
  approved: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export function canTransition(from, to) {
  return Boolean(requestTransitions[from]?.includes(to));
}

// 兼容既有调用形态的模块级缓存。键恒为完整作用域+申请号；
// 缺少任一作用域字段时拒绝写入、读取一律落空，绝不跨域命中。
const defaultCache = createScopedCache();

export function cacheRequest(request) {
  if (!request?.tenant || !request?.operator || !request?.site || !request?.requestId) return false;
  defaultCache.set(request, request.requestId, request);
  return true;
}

export function getRequest(context, requestId) {
  if (!context?.tenant || !context?.operator || !context?.site || !requestId) return null;
  return defaultCache.get(context, requestId);
}

// 主题重合：纯函数，调用方必须只传入同一县域的记录（见 service.negotiate）。
export function findTopicOverlap(allRequests, topicCodes) {
  const codes = Array.isArray(topicCodes) ? topicCodes : [];
  return allRequests.filter(item => item.topicCodes?.some(code => codes.includes(code)));
}
