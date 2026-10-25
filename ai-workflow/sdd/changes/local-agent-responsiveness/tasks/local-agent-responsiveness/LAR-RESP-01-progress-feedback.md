# 进度反馈与正文隔离

- Parent: [local-agent-responsiveness](INDEX.md)
- Change: local-agent-responsiveness
- Task: LAR-RESP-01
- Design: [local-agent-responsiveness](../../design/local-agent-responsiveness.md)
- 状态：已完成本地离线验收

交付设计第 3 节。复用活动事件与工作状态行，加入真实阶段、公开摘要和可重试错误处理。修正共享归并以保持正文不受状态影响；首次正文计时语义保持不变。

验收：初始化阻塞时先有状态；公开摘要有界合并；原始推理不出适配层；重试不误报失败、不重复输入；正文交错、重连、审批与终态无污染。Web/Electron 与 Mobile 共用状态映射，语言资源完整。

## 验收证据

- 原生驱动、Host、摘要节流、共享归并、Web/Mobile 事件归并与首个正文计时相关测试通过，共 426 项。
- adapters、Web、Mobile 类型检查通过；改动源码 Biome 与差异空白检查通过。
- 阻塞初始化夹具验证连接活动先持久化和输出；公开摘要有界合并，原始推理与提供方私密错误不进入对外事件。结构化限流重试后同一输入只提交一次并正常完成。
- 已添加使用真实 Transcript 的离线浏览器夹具与 CI 截图场景；本次未执行浏览器视觉或本机 Electron E2E，不宣称 CI 截图已生成。
- Page SEO 私有应用例外见任务包索引；未增加路由或改动公开索引配置。

复盘：首轮测试暴露新增活动导致旧序号断言变化，以及正文/活动过滤后的类型收窄问题。先运行相关基线与共享归并测试比依赖真实模型重试更快；后续继续使用虚拟时钟和假 CLI。
