// 统一错误码：越权与不存在共用 NOT_FOUND，调用方无法从错误响应推断他县对象是否存在。
export const errorCodes = Object.freeze({
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_STATE: 'INVALID_STATE',
  WINDOW_UNKNOWN: 'WINDOW_UNKNOWN',
  WINDOW_FULL: 'WINDOW_FULL',
  VALIDATION: 'VALIDATION',
});

export class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}
