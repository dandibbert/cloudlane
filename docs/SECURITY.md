# 安全设计与运维清单

## 信任边界

管理员能够使用面板内所有业务 Token 的权限。这不是多人租户隔离系统。Workers 部署账户、GitHub 部署工作流、管理员密码、主加密密钥都属于高权限资产；获得代码部署或 Secret 权限的攻击者可以修改代码读取解密后的 Token。AES-GCM 不是对部署账户管理员的保密隔离。

业务 Token 从 HTTPS 页面输入，经同源会话 API 校验和加密，持久化只保存密文。前端收到的凭据列表只有名称和账户等元数据。Token 不进入 localStorage、配置导出或常规审计日志。演示模式绝不要填写真实 Token，尽管其状态仅在当前页内存中。

## 登录与请求

- 独立高熵管理员密码至少 16 字符，随机会话 12 小时过期；修改密码使所有旧会话失效。
- 会话摘要服务端保存，Cookie 使用 HttpOnly、SameSite=Strict、HTTPS Secure/`__Host-` 前缀。
- 可变 API 校验 Origin 与请求自身 origin 一致，拒绝跨站表单；JSON 流式限制 64 KB。
- 登录错误次数按 Cloudflare 提供的来源 IP 摘要限制。该措施不是对分布式攻击的完整防护；需要时额外添加 WAF/Access。
- HTML 动态内容统一转义；静态 CSP 不加载外部脚本、字体与分析器；禁用 iframe 嵌入与内容嗅探。

本版没有 MFA、OIDC、密码找回邮件或 Access JWT 验证。可在 Cloudflare 边缘额外保护管理入口，但应确保默认 `workers.dev`、自定义域名和其它路由都不能绕过新增策略。

## 远程操作

所有业务 API 都限制为固定 Cloudflare API 地址，Token 不被发送给用户提供的优选域名。API 禁止重定向，不跟随到另一个主机。服务 URL 只写入 Tunnel 配置，不在 Worker 内执行任意网络探测。

精确 hostname/Zone 归属验证、资源冲突检测和快照核对是保护误操作，不是对“已掌握管理员权限但恶意操作的人”的隔离。Cloudflare 无副作用读权限探测也不能证明所有写权限已正确授予。

Cloudflare 返回的证书验证 TXT 只允许匹配 `_cf-custom-hostname.<当前访问域名>` 或 `_acme-challenge.<当前访问域名>`。其它名称拒绝自动写入。已有 TXT 不为了方便而清空，DNSSEC、CAA、Zone hold 不自动关闭。

## 数据恢复

主密钥使用 32 字节随机值，经标准 base64 保存。密钥丢失或未经迁移直接更换会导致现有密文不可读；不能从元数据导出里恢复 API Token。业务 Token 换新应编辑对应凭据，不轮换主密钥。

导出仅用于检查、留档和辅助人工重建，不是完整备份，没有一键恢复功能。审计仅保留最近 300 条，前端最多显示最近 100 个任务摘要；任务写入日志另存但没有外部归档。不要在没有独立备份策略时删除 DO、改对象命名或从迁移历史中删类。

## 上线前检查

先审查并限制两类 Token：部署 Token 用于部署账户；业务 Token 用于源/访问 Zone。不要混用 Global API Key，不在工作流 env 之外打印 Secrets，不提交 `.dev.vars`、`.env`、令牌或自定义证书私钥。

先在非关键 hostname 上完整执行创建、等待、实际访问、服务修改、暂停/恢复、撤销，再导入生产服务。检查已有 Tunnel 规则数量、顺序、全局回源参数前后不变。部署或关键变更前避免其它脚本同时写同一个 Tunnel。

GitHub Actions 示例使用主版本标签，正式长期运营时建议将第三方 action 固定到已核验的提交 SHA，并对依赖锁文件与更新建立审查流程。本次本地测试没有下载 Wrangler，没有运行 GitHub workflow，也没有对云端执行写入。

出现 Token 泄漏时，先在 Cloudflare 吊销该 Token，再更换面板内凭据、管理员密码并检查部署权限与任务日志。仅改面板密码不会吊销已泄漏的 Cloudflare Token。