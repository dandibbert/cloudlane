# 架构与执行边界

## 组件

```text
浏览器 ──同源 Cookie/JSON──▶ Worker /api/* ──▶ ControlPlane Durable Object
   │                                             │
   └── public/ 静态资源                           ├── SQLite-backed storage KV 接口
                                                 │   凭据密文、方案、记录、计划、任务
                                                 ├── Alarm 调度器
                                                 └── 固定目标 Cloudflare API
```

使用一个 DO 统一协调是有意取舍：个人面板通常跨方案修改同一个 Tunnel 或共享入口，需要可理解的串行控制。没有 D1 与 DO 两套数据库之间的一致性问题，也不用浏览器轮询来驱动任务。此设计不宣称适用于大规模多租户；未来扩容需要先明确 Tunnel/Zone/共享资源的锁归属，再分片，不能简单按记录拆开并发写整份 Tunnel 配置。

前端没有框架构建运行时，使用 ES modules、静态 SVG 图标和 CSS。部署目录是 `public/`，Worker 入口是 `worker/index.mjs`。`npm run build` 检查语法并生成离线演示，不负责调用 Cloudflare；正式 Worker 打包由 Wrangler 完成。

## 存储模型

| 前缀 | 主要数据 | 说明 |
| --- | --- | --- |
| `credential:` | id、账户、名称、AES-GCM 密文 | 主密钥只在 Worker Secret |
| `profile:` | 两侧凭据与 Zone、Tunnel、入口、验证策略 | 引用后锁定基础归属 |
| `route:` | 管理映射、名称/备注、预期值、最近远端快照 `remote`、观测值 | Cloudflare 是事实源；本地保存映射与缓存，不把缓存冒充实时状态 |
| `plan:` | 输入、快照、动作、警告、过期时间、jobId | 审批后幂等绑定任务 |
| `job:` | 计划副本、动作日志、状态、重试、下次时间 | 每个动作具备独立写入状态 |
| `audit:` | 时间、事件、任务 ID | 最近 300 条；任务日志另存 |
| `session:` | 随机会话摘要、密码版本、到期时间 | 不存 Cookie 明文 |
| `rate:` | 登录来源摘要、次数、窗口 | 8 次/15 分钟 |

DO 使用 SQLite 后端，但代码依赖 `state.storage` 的事务/KV API；没有额外 SQL 驱动。对最终生产 runtime 的兼容性仍需实际 Wrangler 打包和部署验证。

## 从预览到执行

**预览是只读的。**验证输入和方案归属，读取现有配置，检查所有已知冲突，生成动作列表；不会为了“检查权限”创建再删除资源。动态的证书验证 token 尚未出现时，只在预览说明其后续步骤。

审批需要当前管理员会话、同源请求、明确勾选确认和未过期计划；**普通新增/编辑不要求重复输入完整域名**。只有“删除云端资源”这类破坏性计划要求再次输入完整访问 hostname。后端再次核对方案、记录和全部已知资源快照。用 DO 事务同时保存任务、计划与记录接管状态，然后安排 Alarm；该事务不包含 Cloudflare 外部 API。

每个动作写入之前再读当前远端状态，比较 `before`。正式调用之前把 `state=writing` 存入日志。成功后保存 API 正规化后的 `applied`，再标 `done`。

```text
queued → running → waiting（异步所有权/hostname/fallback；SSL 可继续 pending）→ running → done
            │
            ├→ retrying（部分暂态故障；先读回核对）
            ├→ failed（冲突、权限、不可继续的验证状态）
            └→ paused（手动暂停或超过 24 小时）
```

单次 Alarm 处理一个动作或一个检查，随后安排下一次。DO Alarm 是至少一次语义，所以不能把“函数执行了一遍”当作外部写入恰好一次。DNS 创建携带唯一 comment 标记，用于响应中断后的匹配；SaaS 创建缺少同等可证明的唯一创建标识，匹配到同名结果时会标记所有权不确定，允许继续验证，但禁止撤销删除该主机名。

新记录默认 setup 顺序：Tunnel 合并、缺失共享入口、源 CNAME、可选备用源、SaaS hostname、Delegated DCV。其后动态读取并写入所有权/必要证书 TXT。默认切换策略只要求 **SaaS hostname active + Fallback Origin active**，并在切换前再次检查配置没有漂移；SSL `pending_validation` 继续展示与维护，但不阻断访问 CNAME。风险模式仍可在 hostname 尚未 active 时提前切换。

关闭页面不会主动取消任务；暂停保留已经完成的变更。失败后重试会重新核对未完成动作，不整单重复 POST。计划审批重复请求返回同一 jobId。

## 修改原 Tunnel，而不是重建 Tunnel

Tunnel PUT 会替换**配置对象**，不是删除/重建 Tunnel 本身。代码先读取当前完整配置，在内存中只合并或移除目标 hostname 的精确 ingress，再把完整结果写回同一个 Tunnel。未知顶层字段、全局 `originRequest`、无关 ingress、每条已存在规则的未知字段及终止 catch-all 都保留。新精确 hostname 在会遮挡它的通配符之前插入；重复 hostname、path 路由、异常 catch-all 直接报错，不猜测优先级。

已管理记录能明确修改自身规则；未管理记录遇到冲突需先导入。跨账户、Zone、Tunnel 或 hostname 迁移需要新对象，不在一次普通“编辑”里偷偷完成。

## 云端删除是独立的破坏性计划

“仅解除管理”只移除本地 `route:` 映射；“删除云端资源”必须先读取当前远端状态并生成独立 delete plan。删除计划只作用于能够明确归属到该记录的资源：访问 DNS、该 hostname 的验证 DNS、Custom Hostname、专属源 DNS，以及 public/origin 两条精确 Tunnel ingress。

共享 `speed.*` 入口和 SaaS Fallback Origin 永不随单条记录删除。若源 hostname 被其它 Custom Hostname 复用，则源 DNS 与 origin ingress 也保留。任何 path ingress、重复 hostname、Custom Hostname custom origin 漂移等归属不明确情况会拒绝生成删除计划。执行前要求勾选并输入完整访问 hostname；删除任务完成后不能提供“一键撤销”，因为 Cloudflare 已删除的证书/Custom Hostname 等资源需要重新创建。

## 撤销并非强制回滚快照

撤销也是新预览和新任务，按成功动作的逆序生成。每个当前值必须仍与原 `applied` 一致；否则停止，不覆盖后来更改。任务后面已有新任务时禁止跳过新任务撤销旧任务；撤销任务不能再撤销自身。

共享入口、共享备用源、复用的资源、不确定创建者的 hostname、纯验证刷新事件不做单条记录的破坏性清理。共享入口单独任务的撤销，会同时恢复该入口真实 DNS 和方案预设，并提示共同使用者影响。

没有完整跨服务原子事务保证，也没有 Cloudflare 配置 API 的服务端 compare-and-swap。最后读取与写入之间的外部竞争窗口仍存在。因此面板不能与其它同时管理同一 Tunnel 的脚本安全地“随意并行”。

## 观测和后台维护

远端同步按配置方案批量读取 Tunnel 配置、源/访问 DNS、SaaS Custom Hostnames、fallback，并将实际 service/custom origin/edge CNAME 与管理映射分离存入最近快照。登录后前端主动同步，手动刷新立即重读；页面可见时周期性刷新。同步还会产出尚未纳入管理、但可识别的导入候选。常规 UI 轮询读取 DO 快照，不把每次界面刷新都变成 Cloudflare 全量扫描。

观测分别读取 Tunnel 连接状态、两个 ingress、源/访问 DNS、SaaS hostname/SSL、fallback、源 Zone 内的入口链。SSL `pending_validation` 始终可见，但本身不把控制面可用链路降级为 pending；证书维护任务也不会覆盖卡片的实时 route readiness。

不请求用户配置的 `service` 或任意外部 URL：Worker 的 `localhost` 与 cloudflared 的 `localhost` 不同，探测既会误导，也会引入 SSRF。`originReachability=not_tested` 始终明确记录，实际业务验证需要用户从目标网络进行。

正常记录约每 6 小时检查一次。只有已批准接管且配置没有漂移的记录，才会创建验证维护任务；导入即默认开启写维护会越权，因此导入对象只读。维护仅允许返回值中和该 hostname 精确对应的验证名称，不自动改变公共流量 DNS，不自动删除未知 TXT。

## 管理 API

以下均位于 `/api`，除 bootstrap/login 外要求会话。可变请求还要求匹配的 Origin；有请求体的接口使用 JSON。面板会完成这些调用，不需要用户编写 API 脚本。

| 方法与路径 | 行为 |
| --- | --- |
| GET `/bootstrap` | 安装状态、登录状态、版本 |
| POST `/login`、`/logout` | 建立/注销管理会话 |
| GET `/state`、`/export` | 面板状态、非秘密元数据导出 |
| POST `/credentials`；PUT/DELETE `/credentials/:id` | 凭据管理 |
| GET `/credentials/:id/catalog` | 按账户范围枚举 Zone、Tunnel |
| POST `/profiles`；PUT/DELETE `/profiles/:id` | 配置方案 |
| POST `/profiles/:id/discover`、`/import` | 只读发现、只登记导入 |
| POST `/profiles/:id/sync` | 按方案从 Cloudflare 深度同步当前 Tunnel/SaaS/DNS/Fallback，并刷新已管理记录与导入候选 |
| POST `/profiles/:id/edge-plan` | 共享入口独立变更预览 |
| POST `/plans`、`/plans/:id/apply` | 新建/编辑预览、确认执行 |
| GET `/jobs/:id` | 详细动作日志 |
| POST `/jobs/:id/pause`、`/retry`、`/rollback-plan` | 任务控制；破坏性 delete 不能生成一键撤销 |
| POST `/routes/:id/delete-plan` | 生成“删除云端资源”预览；共享入口/Fallback 与共享源资源受保护 |
| POST `/routes/:id/sync` | 同步该记录所属方案的真实远端状态 |
| DELETE `/routes/:id` | 仅解除面板管理；UI 为单次勾选确认，Cloudflare 资源完整保留 |


返回错误使用 `{ "error": { "code", "message", "details"? } }`。凭据查询不含密文或 Token。Custom Hostname 响应仅保存必要配置，不持久化其证书私钥或 PEM。回源参数、域名与 DNS 验证记录属于控制面数据，只有管理员可读。