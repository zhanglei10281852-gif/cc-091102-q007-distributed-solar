/**
 * 业务存储（内存实现，接口可平移到持久层）。
 *
 * 关键不变量：
 *  - 所有读取接口都必须带 tenant，内部使用复合键，调用方永远无法仅凭 requestId
 *    拿到别的县的记录（双县同号样例的核心要求）。
 *  - 写采用“读-改-写 + version 乐观并发”，跨县同号落在不同键上，天然互不阻塞、互不影响。
 *  - 缓存只保存脱敏后的视图，且以复合键与版本号标记；任何写使该键缓存失效，
 *    绝不做“命中即返回而不校验作用域”的捷径。
 */
import { requestKey } from './scope.js';

export class ScopedStore {
  #requests = new Map(); // requestKey(tenant, requestId) -> { version, record }
  #cache = new Map(); // 同复合键 -> { version, view }

  /** 仅在本租户内按申请号读取原始记录；不存在或跨租户都返回 null（对外不可区分）。 */
  loadRaw(tenant, requestId) {
    const entry = this.#requests.get(requestKey(tenant, requestId));
    return entry ? entry.record : null;
  }

  /** 带版本的读，供乐观并发与缓存一致性使用。 */
  loadVersioned(tenant, requestId) {
    const entry = this.#requests.get(requestKey(tenant, requestId));
    return entry ? { record: entry.record, version: entry.version } : null;
  }

  has(tenant, requestId) {
    return this.#requests.has(requestKey(tenant, requestId));
  }

  /** 列出租户内全部记录（或全部县，仅供服务层在已授权的省级路径调用）。 */
  list(tenant = null) {
    const all = [];
    for (const { record } of this.#requests.values()) {
      if (tenant === null || record.tenant === tenant) all.push(record);
    }
    return all;
  }

  insert(record) {
    const key = requestKey(record.tenant, record.requestId);
    if (this.#requests.has(key)) return false;
    this.#requests.set(key, { version: 1, record: { ...record, version: 1 } });
    this.#cache.delete(key);
    return true;
  }

  /**
   * 条件更新：expectedVersion 必须与当前版本一致，否则返回 null（并发冲突）。
   * mutator 基于当前记录返回新的字段集合。
   */
  update(tenant, requestId, expectedVersion, mutator) {
    const key = requestKey(tenant, requestId);
    const entry = this.#requests.get(key);
    if (!entry) return null;
    if (entry.version !== expectedVersion) return null;
    const next = { ...entry.record, ...mutator(entry.record), version: entry.version + 1 };
    this.#requests.set(key, { version: next.version, record: next });
    this.#cache.delete(key); // 写即失效：缓存可能保留的旧脱敏视图立即下线
    return next;
  }

  /**
   * 读取脱敏视图缓存。版本不匹配（或无缓存）返回 null，调用方必须重新走作用域校验后回填。
   */
  readViewCache(tenant, requestId, version) {
    const hit = this.#cache.get(requestKey(tenant, requestId));
    return hit && hit.version === version ? hit.view : null;
  }

  writeViewCache(tenant, requestId, version, view) {
    this.#cache.set(requestKey(tenant, requestId), { version, view });
  }

  clear() {
    this.#requests.clear();
    this.#cache.clear();
  }
}
