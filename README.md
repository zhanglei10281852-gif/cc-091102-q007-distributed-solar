# 户用光伏抽检统筹

省级分布式光伏平台按县域隔离户用光伏抽检计划。业务对象由县域、运营商和脱敏站点编号共同定位；省级管理视图只提供跨县聚合数字。`fixtures/incident.json` 用两个县中相同的申请号 `SAMPLE-1` 展示作用域边界。

使用 Node.js 20，`npm test` 运行测试，`npm start` 启动本地接口（默认 8080，`PORT` 可改）。实际户主资料、访问令牌和运行缓存不得提交。

## 作用域模型

- **租户来源唯一**：租户（县）永远取自已认证令牌，不接受请求参数或路径指定。县级主体在读路径上结构上无法寻址邻县记录。
- **复合键存储**：申请记录主键为 `租户:申请号`，跨县同号天然互不影响；容量、窗口、站点冲突全部只在同租户内计算。
- **缓存不跨域**：读缓存以复合键 + 版本号标记，仅在作用域守卫通过且版本一致时命中；任何写使该键缓存立即失效。
- **存在性不可推断**：跨域访问（含省级账号探明细、载荷携带他县租户）统一返回与普通未命中逐字节同构的 `404 {"error":{"code":"not-found"}}`，并进入审计流；同租户内非属主的写才返回 403。
- **省级无明细**：省级账号的任何明细读写均拒绝；`/stats` 仅返回按县的状态计数，不含申请号、站点编号、运营商等标识。

## 角色

| 角色 | 明细读 | 写 | 统计 |
|---|---|---|---|
| `province` | 否（404+审计） | 否 | 跨县聚合，仅计数 |
| `county-admin` | 仅本县 | 本县全部 | 本县 |
| `operator` | 仅本县且本人属主 | 仅本人记录；创建时属主强制为自身，不可伪造 | 本县本人 |

## 状态链

```
submitted ──negotiate──▶ negotiating ──lock-window──▶ window-held ──approve──▶ approved
     └────────── submitted/negotiating/window-held 均可 cancel ──────────▶ cancelled
```

`window-held` 带 `heldUntil`（默认 15 分钟 TTL），超时在下次读取时惰性回退 `negotiating` 并释放容量。锁窗时校验本县重叠窗口容量（默认每县 2）与同脱敏站点时间冲突。

## HTTP 接口

Bearer 令牌鉴权（`Authorization: Bearer <token>`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/requests` | 创建申请（同县同号 409；载荷 `tenant` 与令牌不符按 404+审计） |
| GET | `/requests` | 本县列表（运营商仅本人记录） |
| GET | `/requests/:id` | 本县明细 |
| POST | `/requests/:id/negotiate` | 主题重合协商（仅同县活动申请） |
| POST | `/requests/:id/lock-window` | 锁窗口 `{start,end}`，校验容量与同站点冲突 |
| POST | `/requests/:id/approve` | 核准 |
| POST | `/requests/:id/cancel` | 取消 `{reason?}` |
| GET | `/stats` | 县级=本域计数；省级=按县聚合，无标识 |
| GET | `/audit` | 仅省级：越权尝试审计流 |

## 本地联调令牌

`src/server.js` 内置仅用于联调的演示令牌（生产应由密钥管理注入）：

| 令牌 | 主体 |
|---|---|
| `demo-province` | 省级管理员 |
| `demo-county-a` / `demo-county-b` | 两县管理员 |
| `demo-op-a` | county-a 的运营商 op-solar-1 |
