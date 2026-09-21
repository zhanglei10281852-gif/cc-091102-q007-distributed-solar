# 户用光伏抽检统筹

省级平台按县域隔离户用光伏抽检计划。业务对象由县域、运营商和脱敏站点编号共同定位；省级管理视图只提供聚合数据。`fixtures/incident.json` 使用两个县中相同的申请号展示作用域边界。

## 安全模型

- **共同作用域**：每条申请由 `县域 + 运营商 + 脱敏站点 + 申请号` 唯一定位。两个县并行处理相同申请号时，容量与状态链互不影响。
- **租户边界**：所有读取与状态变更都强制校验访问者绑定的县域。县级用户声明他县作用域、或用仅他县存在的申请号探测，一律返回与"不存在"完全一致的 404，并写入审计流。
- **缓存隔离**：缓存键恒为完整作用域四元组，相同申请号不会跨县命中；缺少任一作用域字段的写入被拒绝。
- **省级聚合**：`province-admin` 只能读取跨域聚合（各状态计数、窗口水位），聚合不含户用站点标识与申请号；其明细读取与写操作一律 403 并入审计。
- **审计流**：所有越权尝试（跨域声明、跨域探测、角色越权）记录到内存审计流，不随响应泄露。

## 状态链

`submitted → negotiating → window-held → approved`，任意非终止态可转为 `cancelled`；`approved` / `cancelled` 为终止态。窗口容量按县域独立扣减，取消释放已锁容量。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/domain.js` | 状态常量、迁移表、主题重合纯函数、兼容既有调用的作用域缓存 |
| `src/store.js` | 业务存储：作用域定位、按县独立的窗口容量 |
| `src/cache.js` | 作用域缓存策略（TTL + 四元组键） |
| `src/context.js` | 访问者与角色（作用域传播） |
| `src/service.js` | 申请/协商/锁窗/批复/取消/统计/聚合与权限校验 |
| `src/audit.js` | 审计流 |
| `src/server.js` | HTTP 接口 |

## HTTP 接口

身份经请求头传播：`x-actor-id`、`x-actor-role`（`county-user` / `province-admin`）、`x-actor-tenant`（县级必填）、`x-actor-operator`（可选绑定）。

- `GET /` — 状态接口（无需身份）
- `POST /requests` — 申请 `{ operator, site, requestId, topicCodes? }`
- `GET /requests/:tenant/:operator/:site/:requestId` — 明细
- `POST /requests/:tenant/:operator/:site/:requestId/negotiate` — 主题重合协商
- `POST /requests/:tenant/:operator/:site/:requestId/hold-window` — 窗口锁定 `{ windowId }`
- `POST /requests/:tenant/:operator/:site/:requestId/approve` — 批复
- `POST /requests/:tenant/:operator/:site/:requestId/cancel` — 取消
- `GET /tenants/:tenant/requests`、`GET /tenants/:tenant/stats` — 本域列表与统计
- `GET /aggregate` — 省级聚合（仅 `province-admin`）
- `POST /windows` — 定义县内检查窗口 `{ tenant, windowId, capacity }`（仅 `province-admin`）

使用 Node.js 20，`npm test` 运行测试，`npm start` 启动本地接口。实际户主资料、访问令牌和运行缓存不得提交。
