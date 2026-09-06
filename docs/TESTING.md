# 测试结果与验收边界

执行日期：2026-09-06。版本：0.2.5。

## 本次确实执行的检查

| 检查 | 结果 | 使用的环境 |
| --- | --- | --- |
| Node 后端/核心/工作流/安全回归 | 70/70 通过 | Node 22，Cloudflare API 使用可控 mock，DO storage 使用内存实现 |
| JavaScript 语法检查 | 15 个模块通过 | `node --check` |
| 离线演示构建 | 通过 | 自包含 HTML，无第三方运行时资源 |
| Wrangler Workers 打包 dry-run | 通过 | Wrangler 4.129.0；DO / Assets / vars 绑定均成功解析 |
| 浏览器交互回归 | 待 GitHub CI 重跑；上一版 UI 基线 27/27 通过 | v0.2.5 改为 Tunnel/service 分组展示，已新增 service-cluster 回归断言 |
| 浏览器错误/外部请求 | 上一版 UI 基线 0 / 0 | 离线页面，监听 pageerror/request；当前改版由 CI 重新确认 |
| 移动端布局 | 上一版 UI 基线通过 | 390 × 844；当前改版由 CI 重新确认 |

原始结果位于 `test-results/backend.tap` 和 `test-results/browser-report.json`。截图同目录。

## 70 项后端测试覆盖

核心域名/IDN/IPv6/服务 URL 验证、apex 与循环拒绝、Tunnel 未知字段/回源参数/catch-all 保留、通配符优先级、重复/path 规则拒绝、DNS canonical form、AES-GCM 随机性和 AAD、Secrets fail-closed。

真实 Worker 路由与业务代码经 mock Cloudflare 执行：预览只读、普通审批单次勾选、审批幂等、**SSL pending 不阻断默认切换**、所有权和 SSL 分离、已有 TXT 保护、DCV 降级条件、公共 DNS 冲突、远端配置漂移、回源参数不丢失、异步恢复、DNS 唯一归属识别、未知写入阻止撤销、快照保护撤销、动态验证写入范围、只读扫描/导入、共享源复用、过期计划、暂停/恢复、缺失备用源、跨账户授权、登录/CSRF/密码轮换/限速、分页超限报错。

v0.2 新增回归直接覆盖：按 profile 从真实 mock Cloudflare 深度同步并刷新卡片远端值且同步过程零写入；破坏性云端删除只删除该 route 可明确归属的 DNS/Custom Hostname/精确 ingress，保留无关 Tunnel 顶层字段、其它 ingress、共享入口和 Fallback；另一个 Custom Hostname 共享同一 origin 时，源 DNS 与 origin ingress 必须保留。

额外回归涵盖共享入口真实 DNS 和本地预设共同撤销、Custom Hostname TLS 参数被外部修改时禁止删除、SaaS 创建响应中断后的不确定归属保护、显式验证刷新保留原 method/type、手工证书不可误刷新、fallback 丢失不会显示 ready、终止验证状态、导入记录不自动写维护、撤销预览过期/元数据保护、长 hostname 的证书 branding，以及 Workers 原生 `fetch` 的 receiver 保持、`manual` redirect 模式与 3xx 显式拒绝。v0.2.5 另外覆盖：**同一个 origin 被多个 public hostname 共享时仍可自动发现/导入**；同一 source Zone/Tunnel 下跨 profile 复用 origin 允许；跨不同 source Tunnel 复用同一个 origin 仍会拒绝；删除单个共享访问域名继续保留剩余使用者依赖的 origin DNS / ingress。

Mock 会故意在返回中放入哨兵私钥字符串，测试确保其不进入持久化状态；这不是任何真实凭据。网络中断测试可模拟远端已提交但客户端未收到响应，不只模拟请求发出前失败。

## 浏览器检查覆盖

六条演示记录、**按 Tunnel/service 生成服务分组**、桌面卡片 domain/status 列严格对齐、SSL pending 仍显示“配置就绪”、搜索焦点、待处理筛选、多方案/账户筛选、漂移诊断、不伪装源站探测、弹窗背景 inert、新建先预览、**普通变更不出现手输完整域名确认**、执行日志、编辑 hostname 锁定、动态名称转义、发现/选择/导入、多账户 catalog、共享入口独立预览、Token 不回显、Tunnel 资源、任务展开、操作日志/使用指南、**云端删除必须独立预览 + 手输完整 hostname**、手机无横向溢出、移动导航、移动表单、键盘焦点圈定、零 JS 异常与零外部请求。

浏览器测试的是清楚标注的离线演示入口和前端交互；后端测试使用真实业务代码但 mock 外部系统。两者**均不等于**部署到 Workers 后接入真实 Cloudflare 的端到端测试。

## 尚未执行

`wrangler deploy --dry-run` 已在本次环境通过；本地 Wrangler runtime 也能启动 Worker，`/api/bootstrap` 返回当前版本。本沙箱的 Chromium 因系统字体/GPU 目录访问限制无法启动，所以没有把旧的 27/27 浏览器结果冒充成本次重新执行；GitHub Actions 仍会在标准 Ubuntu runner 上重新跑完整浏览器套件。尚未执行的是生产 `wrangler deploy` 后带真实 Cloudflare Token 的端到端写入验收，因此仍未验证你账户中的套餐权益、账户权限差异、CAA/DNSSEC、真实证书签发、外部优选域名行为、云端 Alarm 唤醒、跨进程 DO 存储恢复与真实网络访问效果。

交付时没有将任何已有 Tunnel/DNS/SaaS 配置改动。

## 首次真实验收建议

选择不承载重要业务的两个新子域名，保留当前 Tunnel 配置和 DNS 清单。首先确认 Token 读取资源和 `wrangler deploy --dry-run` 可用，再运行第一次创建；默认策略会在 SaaS hostname 与 Fallback active 后允许切换访问 CNAME，即使 SSL 仍为 pending，因此第一次验收要在你的实际网络主动验证 HTTP/HTTPS，并继续观察证书最终状态。

随后测试编辑服务 URL，核对其它 ingress 与全局参数不变；用非关键记录测试撤销；手工增加一条无关规则后确认陈旧预览被拒绝。最后导入一个已经工作的服务，确认 Cloudflare 端没有新增写入。

不要拿生产域名的首次创建/撤销试验代替测试环境。