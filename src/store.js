import { ServiceError, errorCodes } from './errors.js';

// 业务存储：记录以 县域+运营商+脱敏站点+申请号 共同定位，
// 检查窗口容量按县域各自独立维护，两县并行处理相同编号互不影响。
export function createStore() {
  const records = new Map(); // scopedKey -> record
  const windows = new Map(); // tenant -> Map(windowId -> { capacity, holds:Set<scopedKey> })

  const keyOf = (scope, requestId) =>
    JSON.stringify([scope.tenant, scope.operator, scope.site, requestId]);

  return {
    put(record) {
      records.set(keyOf(record, record.requestId), record);
      return record;
    },
    get(scope, requestId) {
      return records.get(keyOf(scope, requestId)) ?? null;
    },
    listByTenant(tenant) {
      return [...records.values()].filter(record => record.tenant === tenant);
    },
    listTenants() {
      const tenants = new Set([...windows.keys()]);
      for (const record of records.values()) tenants.add(record.tenant);
      return [...tenants].sort();
    },
    // 仅回答"该申请号是否存在于其他县域"，用于识别越权探测，不暴露任何明细。
    existsInOtherTenant(tenant, requestId) {
      for (const record of records.values()) {
        if (record.requestId === requestId && record.tenant !== tenant) return true;
      }
      return false;
    },
    defineWindow(tenant, windowId, capacity) {
      if (!windows.has(tenant)) windows.set(tenant, new Map());
      windows.get(tenant).set(windowId, { capacity, holds: new Set() });
    },
    holdWindow(tenant, windowId, scopedKey) {
      const window = windows.get(tenant)?.get(windowId);
      if (!window) throw new ServiceError(errorCodes.WINDOW_UNKNOWN, '检查窗口不存在');
      if (window.holds.has(scopedKey)) return;
      if (window.holds.size >= window.capacity) {
        throw new ServiceError(errorCodes.WINDOW_FULL, '检查窗口容量已满');
      }
      window.holds.add(scopedKey);
    },
    releaseWindow(tenant, windowId, scopedKey) {
      windows.get(tenant)?.get(windowId)?.holds.delete(scopedKey);
    },
    windowsFor(tenant) {
      return windows.get(tenant) ?? new Map();
    },
  };
}
