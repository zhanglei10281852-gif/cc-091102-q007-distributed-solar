/**
 * 业务错误类型。所有错误都带 HTTP status 与机器可读 code，
 * 便于接口层在不泄露内部细节的前提下返回统一结构。
 */
export class DomainError extends Error {
  constructor(message, { status = 400, code = 'bad-request' } = {}) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}

/** 404：对象不存在，或对象位于调用方作用域外——对外表现完全一致，避免存在性探测。 */
export class NotFoundError extends DomainError {
  constructor(message = 'request not found') {
    super(message, { status: 404, code: 'not-found' });
    this.name = 'NotFoundError';
  }
}

/** 409：同作用域内重复申请、状态流转冲突、窗口容量/同站点冲突。 */
export class ConflictError extends DomainError {
  constructor(message = 'conflicting state', code = 'conflict') {
    super(message, { status: 409, code });
    this.name = 'ConflictError';
  }
}

/** 403：已认证主体无权执行该类操作（如省级账号试图写明细）。 */
export class AuthorizationError extends DomainError {
  constructor(message = 'forbidden') {
    super(message, { status: 403, code: 'forbidden' });
    this.name = 'AuthorizationError';
  }
}

/** 401：无法解析出主体。 */
export class AuthenticationError extends DomainError {
  constructor(message = 'unauthorized') {
    super(message, { status: 401, code: 'unauthorized' });
    this.name = 'AuthenticationError';
  }
}
