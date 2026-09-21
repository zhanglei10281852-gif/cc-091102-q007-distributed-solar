// 作用域缓存：缓存键恒为 县域+运营商+脱敏站点+申请号 四元组。
// 相邻县即使使用相同申请号，键空间也互不相交，从结构上杜绝缓存串号。
export function createScopedCache({ ttlMs = 30_000, now = () => Date.now() } = {}) {
  const entries = new Map();

  const keyOf = (scope, requestId) =>
    JSON.stringify([scope?.tenant ?? null, scope?.operator ?? null, scope?.site ?? null, requestId ?? null]);

  return {
    get(scope, requestId) {
      const key = keyOf(scope, requestId);
      const hit = entries.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return hit.value;
    },
    set(scope, requestId, value) {
      entries.set(keyOf(scope, requestId), { value, expiresAt: now() + ttlMs });
    },
    invalidate(scope, requestId) {
      entries.delete(keyOf(scope, requestId));
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
