# Cloudflare 官方接口依据

核对日期：2026-09-05。以下为实现决策的官方资料，不表示 Cloudflare 对第三方优选域名链提供支持保证，也不代表本项目已通过官方认证。

| 接口/主题 | 本项目采用的约束 | 官方来源 |
| --- | --- | --- |
| Tunnel 配置更新 | 远程管理；PUT 是全量替换，需保留 ingress 和 originRequest | https://developers.cloudflare.com/api/typescript/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/ |
| Hostname 与 SSL 状态 | API 中 `status` 与 `ssl.status` 独立；Cloudflare 对 production HTTPS 的官方 ready 定义仍要求两者 active。Cloudlane 按管理员策略允许 SSL pending 时切换流量，但会持续显示该风险；重新验证使用原 method/type 的 PATCH | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/validation-status/ |
| SaaS 接入流程 | 备用源、主机名、证书验证和 DNS 接入是不同步骤 | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/ |
| 删除 Custom Hostname | DELETE 会永久删除 custom hostname，并撤销为其签发的 SSL 证书；因此云端删除单独做破坏性确认，不提供一键撤销 | https://developers.cloudflare.com/api/resources/custom_hostnames/ |
| 删除 DNS 记录 | DELETE 永久移除指定 DNS record；删除计划只对当前快照中能明确归属的记录执行 | https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/delete/ |
| 所有权验证 | 所有权与证书验证区分；支持预验证 | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/ |
| DCV Delegation | 一次 CNAME 委派需持续保留；同名 TXT/CNAME 冲突 | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/delegated-dcv/ |
| DCV UUID API | GET `/zones/{zone_id}/dcv_delegation/uuid` | https://developers.cloudflare.com/api/resources/dcv_delegation/ |
| TXT DCV | `ssl.method` 单选；验证记录精确写入，不混淆所有权 TXT | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/txt/ |
| 异步验证数据 | token 可能不会立即返回，需要稍后查询 | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/http/ |
| 证书续期 | Delegated DCV 与 Cloudflare 自动验证，不等于面板保证签发结果 | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/renew-certificates/ |
| Durable Object Alarm | 至少一次执行、每个对象一个当前 Alarm；需要幂等与重新调度 | https://developers.cloudflare.com/durable-objects/api/alarms/ |
| DO 调度建议 | 单 Alarm 保存事件队列，避免无意义频繁唤醒 | https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ |
| DO 配额 | 存储和执行受套餐/资源限制，项目另设保守上限 | https://developers.cloudflare.com/durable-objects/platform/limits/ |

API 地址和产品限制可能随 Cloudflare 更新。部署前以及依赖升级后，应重新核对对应账户的 API 响应和能力，不能只依赖 mock 测试。