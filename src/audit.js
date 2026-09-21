// 审计流：越权尝试的唯一出口。调用方收到的是统一错误，审计事件只在平台内部留存。
export function createAuditStream({ now = () => new Date().toISOString(), sink = null } = {}) {
  const events = [];
  return {
    record(event) {
      const entry = { at: now(), ...event };
      events.push(entry);
      if (sink) sink(entry);
      return entry;
    },
    list() {
      return events.map(event => ({ ...event }));
    },
    get size() {
      return events.length;
    },
  };
}
