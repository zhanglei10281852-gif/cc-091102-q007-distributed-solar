/**
 * 兼容门面：仓库既有的状态常量与主题重合纯函数继续可用。
 * 旧的无租户全局缓存已移除——任何缓存都必须走带复合键与版本号的 ScopedStore，
 * 不能再出现仅凭 requestId 命中的路径。
 */
export { requestStates, SamplingService } from './service.js';
export { ScopedStore } from './store.js';
export { AuthService, AuditLog, ROLES } from './auth.js';
export { DomainError, NotFoundError, ConflictError } from './errors.js';

/**
 * 在“已由调用方限定作用域”的申请集合内查找主题重合。
 * 注意：调用方必须先按租户过滤，函数本身不做跨租户隔离。
 */
export function findTopicOverlap(scopedRequests, topicCodes) {
  return scopedRequests.filter((item) => item.topicCodes?.some((code) => topicCodes.includes(code)));
}
