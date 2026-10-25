# local-agent-responsiveness 任务包

- Change：local-agent-responsiveness
- Design：[local-agent-responsiveness](../../design/local-agent-responsiveness.md)
- 状态：三项均已依次实现并完成本地验收，未部署、未启用复用。
- 执行顺序：01 → 02 → 03，无并行执行。完整综合验收与复盘见 [LAR-RESP-03](LAR-RESP-03-bounded-reuse.md)。

| Task | 范围 | 依赖 | 状态 |
| --- | --- | --- | --- |
| [LAR-RESP-01](LAR-RESP-01-progress-feedback.md) | 阶段、公开摘要、重试、正文隔离及三端共享显示 | 无 | 已验收 |
| [LAR-RESP-02](LAR-RESP-02-session-lifecycle.md) | 生命周期协商、释放、配置、计时和发现缓存 | 01 | 已验收 |
| [LAR-RESP-03](LAR-RESP-03-bounded-reuse.md) | 同一绑定有界复用与恢复、取消、兼容综合验收 | 02 | 已验收 |

## 父级 Definition of Done

- 设计第 3 节由 01 负责，第 4.2、4.3 节由 02 负责，第 4.1 节由 03 负责。
- HTTP 校验、幂等、授权与持久运行边界由 02 承接；进程策略与代次由 03 承接；事件顺序和正文正确性由 01 承接。
- 默认离线测试，验证安全边界和 observable effects；相关类型与 lint 检查通过。
- 旧版本冷启动回退、释放、取消、配置变化与 Host 重启无重发、无串会话。
- 每项保存本地提交；不推送、不部署，不例行运行本机 Electron E2E。
- 索引及设计状态与实测证据一致；不把状态反馈当作正文提速，不宣称未经验证的模型响应时间。

## Page SEO Contract（私有应用例外）

- 范围是登录后的既有聊天状态行，无新公开页面、URL、metadata 或搜索意图。
- 复用现有私有应用边界；无需关键词、公开内容或 sitemap 变更。
- 页面负责人验证由 01 承接共享归并与 Web/Mobile 状态投影测试；本机不要求视觉验收。

## 跨 Change 与暂不执行

依赖 local-agent-codex 已有协议、租约和审批边界；不修改该 Change 的既有任务状态。不调整模型、推理强度、账号限额或工具权限。真实模型质量与费用评估、CI Electron 截图和生产启用不纳入本地离线验收。
