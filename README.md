# Cloudlane · 云径

**把 Cloudflare Tunnel、SaaS 回源和优选 DNS，放进一个清楚、克制的控制台。**

Cloudlane 是面向个人或小团队管理员的自托管面板。它运行在 Cloudflare Workers，使用一个 SQLite-backed Durable Object 保存凭据密文、配置、变更计划和任务。前端为原生 JavaScript/CSS，无运行时依赖、外部字体或分析脚本。界面使用粉、蓝、白配色，支持桌面和手机。

> 版本：0.2.0。已实现真实 Cloudflare API 调用、远端状态同步、持久化任务与受保护的云端删除代码，通过模拟 Cloudflare API 的后端测试与离线浏览器测试。交付环境没有接入真实 Cloudflare 账户，**没有完成生产部署、真实证书签发联调或 Wrangler dry-run**。先用一个非关键测试子域名验收，再管理已有业务。

## 先看界面

直接打开 `dist/cloudlane-preview.html`。这是可点击的离线演示：筛选、编辑、新建、导入和变更预览均可体验；所有变更只存在于页面内存，刷新即恢复，不访问 Cloudflare，也不需要填写真实 Token。

源代码启动方式为 `npm run demo`，打开终端显示的 `http://localhost:8788/?demo=1`。这也是演示，不是后端部署。

## 实际自动化的链路

假设源 Zone 为 `a.com`，访问 Zone 为 `b.com`：

```text
访问域名  1.b.com ── DNS-only CNAME ──▶ speed.a.com ──▶ 你选择的优选入口
           │
           └── 在 a.com 的 SaaS 中注册，custom_origin_server = 1.a.com
                                                       │
源域名    1.a.com ── proxied CNAME ──▶ <Tunnel UUID>.cfargotunnel.com
                                                       │
Tunnel    1.a.com + 1.b.com ────────────────────────────▶ http://localhost:1111
```

`localhost` 指 **运行 cloudflared 的那台机器或其容器的网络空间**，不是 Worker，也不是打开面板的设备。Docker 场景请确认 `host.docker.internal`、容器服务名或主机地址确实能从 cloudflared 访问。

面板配置该链路，但不会运营优选 IP 服务，也不承诺外部优选域名、特定运营商直连效果或 Cloudflare 未作稳定性承诺的第三方优选接入方式永久可用。最终应在你的实际网络上访问 `1.b.com` 验证。

## 已实现

| 模块 | 能做什么 |
| --- | --- |
| 优选记录 | 以 Cloudflare 远端状态为事实源；搜索、筛选、双域名与入口展示、服务地址修改、诊断、仅解除管理与受保护的云端删除 |
| 配置方案 | 多 Tunnel、多源 Zone、多访问 Zone、多入口；源账户与访问账户可不同 |
| 凭据保险箱 | 多 API Token；按账户读取 Zone/Tunnel；更换 Token；密文保存，不回显 Token |
| 自动配置 | 合并双 ingress、源 CNAME、SaaS 主机名、所有权 TXT、DCV、按条件切换公共 DNS |
| 既有记录导入 | 扫描 Tunnel、SaaS 和两个 Zone 的 DNS，显示可导入项与不匹配原因；导入本身不改 Cloudflare |
| 安全执行 | 预览、逐项前后差异、普通变更单次勾选确认、破坏性删除完整域名确认、过期与并发检查、任务日志、暂停、恢复、受保护撤销 |
| 证书与诊断 | 区分 hostname/SSL/Tunnel/DNS/fallback 状态；SSL pending 作为信息显示而不阻断默认切换；显式重新触发验证与定时检查 |
| 共享入口 | 单独预览更换 `speed.a.com` 的真实 DNS 目标，告知共同使用者影响，不借新增服务偷偷修改 |
| 界面细节 | 粉蓝白响应式布局、统一卡片列网格、焦点圈定、键盘操作、复制、空状态、错误状态、提交防重复、元数据导出 |

## 部署：GitHub Actions，不需要本地构建

项目包含 `.github/workflows/deploy.yml`。把**完整项目**放到你自己的 GitHub 仓库，不能只上传 `public/` 或离线 HTML。第一次部署前可以修改 `wrangler.jsonc` 的 `name`，避免覆盖账户内同名 Worker。

在该仓库的 **Settings → Secrets and variables → Actions** 添加四个 Repository secrets：

| Secret | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | **部署**此 Worker 的 Token；需相应账户 Workers Scripts 编辑与部署所需权限，不是面板内的业务 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 部署此 Worker 的账户 ID |
| `ADMIN_PASSWORD` | 随机生成的独立管理员密码，至少 16 字符；不要复用 Cloudflare 登录密码 |
| `ENCRYPTION_KEY` | 32 字节随机密钥的标准 base64 文本；必须妥善备份，不能随意轮换 |

密钥应由可信的本地密码管理器/随机数工具生成，**不要使用网页随机字符串生成站点**。有 Node 的设备可执行：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

在 Actions 中选择 **Deploy Cloudlane**，手动运行。工作流先校验 Secrets、执行测试和构建，再部署 Worker，最后通过标准输入批量写入两个应用 Secrets。首次部署到写入 Secrets 之间，面板会拒绝登录和管理操作，不会处于无密码开放状态。URL 见 Wrangler 的部署日志。

**该工作流已经编写，但本次交付没有在你的 GitHub/Cloudflare 账户运行。**首次部署前检查工作流源代码与令牌范围。

### CLI 部署（可选）

需要 Node.js 22+、npm、能够下载 Wrangler 的网络环境：

```sh
npm install
npm test
npm run build
npx wrangler login
npm run deploy
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ENCRYPTION_KEY
```

`npm install` 会生成锁文件，建议之后将它提交到自己的仓库，并把 CI 中的安装改为 `npm ci`。本项目固定 Wrangler 的直接版本为 `4.129.0`；交付环境未下载依赖，因此没有伪造 `package-lock.json`。

不用另外创建 D1/KV：`wrangler.jsonc` 已包含 DO 绑定和 SQLite 类迁移。不要擅自更改 `CONTROL` 绑定、`ControlPlane` 类名、迁移历史或代码中的对象名称，否则可能访问不到原有数据。升级前备份密钥、审阅迁移并保留旧版本。

Cloudflare 的套餐、SaaS 额度、Workers/DO 配额与费用以账户当前显示为准；此项目不保证“无限免费”。

## 首次使用顺序

1. **在 Cloudflare 开通源 Zone 的 Cloudflare for SaaS**。涉及套餐或计费确认时由账户管理员完成，面板不会代为开通付费产品。已有 Fallback Origin 会原样保留；没有时可在方案中明确允许初始化。
2. 在面板的 **API 凭据** 新增账户 ID 和业务 API Token；同一账户的两个 Zone 可以共用凭据，不同账户各添加一套。
3. 创建 **配置方案**：选择源账户/Zone、访问账户/Zone、Tunnel，填写 `speed.a.com`。已有入口只填入口名称即可；入口不存在时可同时提供待创建的目标。
4. 已经手工配置过的服务，使用 **导入现有记录**；全新服务使用 **新增优选记录**。输入一个子域名 slug 会自动补全 MAIN/ORIGIN，仍可单独修改。
5. 预览真实变更并勾选一次确认即可执行，**普通新增/编辑不再要求重复输入完整域名**。默认等待 SaaS hostname 与 Fallback Origin ready 后切换访问 DNS，**不等待 SSL active**。可关闭页面，任务由后端继续执行。

### 业务 Token 权限

两个账户可分开授权，也可以由一套凭据管理本账户内的两个 Zone。建议仅授权涉及的 Zone 和 Tunnel 所在账户，不使用 Global API Key。

| 凭据用途 | 需要的范围 |
| --- | --- |
| 源账户 | Account：Cloudflare Tunnel 编辑/Write（API 也接受相应 Cloudflare One Connector Write 权限）；Zone：Zone Read、DNS Edit、SSL and Certificates Edit；范围覆盖源 Zone |
| 访问账户 | Zone：Zone Read、DNS Edit；范围覆盖访问 Zone；不要求 Tunnel 写权限 |
| 单账户共用 | 合并以上权限，Zone 范围包括源与访问两个 Zone |

界面探测“可读取”不等于能提前证明所有“可写”权限。Cloudflare 没有通用的无副作用写权限 dry-run；真实写入仍可能被权限、产品权益、Zone hold 等拒绝。失败时记录已经成功的步骤，不会显示为全部成功。

### 远端状态与本地数据分别是什么

Cloudflare 才是网络配置的事实源。Cloudlane 的 Durable Object 保存的是**管理映射、显示名称/备注、凭据引用、任务/审计和最近一次远端快照**，而不是拿一份本地表格假装云端仍然如此。

登录后会按配置方案主动同步真实的 Tunnel 配置、Custom Hostnames、源 Zone DNS、访问 Zone DNS 与 Fallback Origin；手动“从 Cloudflare 同步”会立即重读，页面可见时也会周期性刷新。常规 UI 状态轮询只读本地快照，避免每 20 秒对 Cloudflare 全量扫一次。同步发现但尚未管理的链路会作为“可导入记录”提示。

如果远端 service、custom origin、优选 CNAME 或其它受管值被手工改动，卡片优先显示最近同步到的真实值，并把相对管理映射的差异标成 drift；修改前仍会重新读取并比较快照。

### 证书验证不是一个开关

`_cf-custom-hostname` 所有权验证和 `_acme-challenge` 证书验证分开处理。默认 `auto` 优先选择 DCV Delegation；若已有 `_acme-challenge` TXT，不删除它，而是保留 TXT 路径。权限/功能不可用时可退回 TXT；网络异常或 429 不被伪装成“功能不支持”。

验证 token 可能延迟出现，任务会重新查询。等待上限 24 小时，之后暂停；部分临时 API 错误最多自动重试 6 次。被 `blocked/moved/deleted/pending_blocked` 阻止时展示错误并停止。处理 CAA、Zone hold、DNS 等根因后，可编辑记录并明确勾选 **重新触发 SaaS 验证**，使用原证书 method/type 发起刷新。不会自动关闭 CAA、DNSSEC 或 Zone hold。

证书 `pending_validation` 本身不再把可用链路判为“未就绪”，也不阻断默认访问 DNS 切换；它仍会在卡片、详情与维护任务中持续可见。定时检查默认约 6 小时一次，只对已批准接管的记录维护确切的验证名称；刚导入的记录只读检查，不自动发起证书写入。证书最终签发、续期由 Cloudflare/CA 完成，面板的轮询与 token 维护不等于续期 SLA。

### 编辑、撤销和删除的含义

- 修改服务 URL、明确指定的 `originRequest` 和单条记录入口，需要新的预览与确认。原本未指定的回源参数不会被顺手清空。
- 修改方案中的“待创建入口目标”是修改**预设**，不会改已有 DNS。真正修改共享 `speed` 的 DNS 使用“入口管理”，它会影响所有使用者，包括面板没有导入的使用者。
- 源/访问 hostname 或 Tunnel/账户/Zone 迁移不能通过原地编辑偷偷完成；新建方案/记录验收后再处理旧记录。
- **“仅解除管理”**只删面板映射，Cloudflare 上的配置全部保留。**“删除云端资源”**会先生成破坏性预览，再要求输入完整访问域名，随后删除这条记录可明确归属的公共 DNS、验证 DNS、Custom Hostname、专属源 DNS 与精确 Tunnel ingress。共享 `speed.*`、Fallback Origin，以及被其它 Custom Hostname 共用的源资源会保留。
- 撤销只处理已确认写入且未被后来修改的资源；共享入口、共享备用源、仅复用的资源和创建者不确定的 SaaS 主机名不会被误删。验证刷新这一事件不能撤销。
- 多步骤跨 API 操作不是数据库原子事务。失败/暂停会保留成功部分，需要查看任务、恢复或显式撤销，不会偷偷“清空重做”。

## 范围与明确限制

本版支持远程管理的 Tunnel、两个独立 Zone 下的确切 HTTP/HTTPS 子域名。同一面板可以管理多套这样的组合。以下情况会明确拦截，不把复杂资源当简单记录覆盖：本地 `config.yml` Tunnel、apex/通配符、同 hostname 多条路径规则、两条规则不一致、多个访问域名共享一个源 hostname、跨服务域名归属冲突。

这里的“多账户”指一个管理员管理自己的多套 Cloudflare 凭据，不是多人 RBAC/多租户 SaaS。没有多人权限、OIDC、租户隔离、外部通知、网络测速或自动选 IP。`healthy` 只展示连接器状态；`ready` 是控制面配置就绪，不表示从家宽/移动网络验证过本地服务、证书握手、HTTP 响应或优选效果。

优选链只检查可管理源 Zone 内的节点和环路，最多 12 跳；一旦离开源 Zone，只展示外部终点，不声称已经验证其递归 DNS/IP/性能。请求不代理任意服务 URL，避免把面板做成 SSRF 探针。

Cloudflare Tunnel 更新接口为整份配置替换，但这**不等于删除或重建 Tunnel**。Cloudlane 每次都是读取现有完整配置，只增加、修改或移除目标 hostname 对应的精确 ingress，同时保留其它 ingress、终止 catch-all、全局 `originRequest`、每条规则上的未知字段以及其它顶层字段，再把合并后的完整配置 PUT 回原 Tunnel。面板会在预览、审批和写入前比较快照，但 Cloudflare API 没有在此实现中可用的服务端 CAS，因此**外部工具在最后一次读取与 PUT 之间写入的极窄竞争窗口无法完全消除**。进行 Tunnel 配置变更时，不要同时在其它脚本或 Cloudflare 控制台改同一个 Tunnel。

安全上限：单次请求 64 KB、预览 500 KB、同时活动任务 30 个、分页扫描最多 100 页（每页 50 条）、变更预览有效期 10 分钟。超过限制会说明失败，不把截断结果当完整清单。面板状态面向几十到数百条个人服务，不适合大规模 SaaS 批量接入。

## 数据、备份与安全

API Token 使用 AES-256-GCM 加密；密钥来自 Worker Secret，凭据 ID 作为认证附加数据。密文保存在 Durable Object，不返回浏览器，不进 localStorage，不导出 Token。会话 Cookie 为 HttpOnly、Secure（HTTPS）、SameSite=Strict；服务端仅保存会话摘要；默认 12 小时过期。修改管理员密码会使旧会话失效。

**必须备份 ENCRYPTION_KEY**。丢失后，现有 Token 密文不能解密；随意更换也会造成同样结果。Token 轮换请在凭据编辑中完成，不需要更换主加密密钥。

“导出配置”仅导出非秘密元数据，不含 Token、会话、任务完整历史，也没有一键恢复导入功能，**不是完整灾备备份**。不要删掉 Worker/DO 或重置其存储。需要迁移整套服务时，应先为 DO 数据制定独立备份恢复方案。

默认关闭 Worker observability 自动日志，源代码不打印 Token。API 会脱敏返回错误，前端动态内容转义，并设置 CSP、禁止框架嵌入与内容嗅探。尽管如此，拥有 Worker 代码/Secrets 管理权限的人可以读取应用使用中的凭据；主密码和部署账户应按高权限控制面保护。

可以额外在 Cloudflare 边缘用 Access/WAF 限制面板入口，但本版没有内置 Access JWT 校验。若自行添加 Access，要覆盖自定义域名及 `workers.dev` 等所有可达入口；不要把 UI 登录以外的入口暴露出去。

## 开发与测试

```sh
npm test                   # Node 原生测试：无外部依赖、Cloudflare 使用 mock
npm run check              # 每个 JS 模块的语法检查
npm run build              # 检查并生成独立离线演示 HTML
npm run dry-run            # 需要已安装 Wrangler；检查 Worker 打包，不产生生产部署
```

浏览器回归使用 Python Playwright：

```sh
python -m pip install playwright==1.57.0
python -m playwright install chromium
python tests/browser.py
```

可用 `CHROME_BIN=/usr/bin/chromium` 指定本机浏览器。测试通过 `set_content` 打开离线演示，避免依赖外部网站；结果不等于真实 Cloudflare 端到端测试。详见 [测试说明](docs/TESTING.md)、[架构](docs/ARCHITECTURE.md)、[安全设计](docs/SECURITY.md)、[接口依据](docs/SOURCES.md)。

## 目录

```text
public/                 原生响应式前端、CSS、图标、离线演示数据
worker/core.mjs          验证、加密、比较、ingress 合并
worker/cloudflare.mjs    Cloudflare API 适配与响应脱敏
worker/planner.mjs       只读计划、逐步执行、动态验证、诊断、发现和撤销
worker/index.mjs         Workers API、登录、持久化、告警任务与定时维护
scripts/                检查、预览、构建
tests/                  单元/工作流/安全/浏览器回归
.github/workflows/      测试与手动云端部署
docs/                   架构、测试、安全、接口依据
wrangler.jsonc          Worker 与 Durable Object 部署配置
```

代码按 MIT 许可证提供；它不是 Cloudflare 官方产品，也不表示受到 Cloudflare 认可。