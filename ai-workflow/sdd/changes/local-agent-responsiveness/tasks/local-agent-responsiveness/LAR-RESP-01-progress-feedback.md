# 进度反馈与正文隔离

- Parent: [local-agent-responsiveness](INDEX.md)
- Change: local-agent-responsiveness
- Task: LAR-RESP-01
- Design: [local-agent-responsiveness](../../design/local-agent-responsiveness.md)
- 状态：实施中

交付设计第 3 节。复用活动事件与工作状态行，加入真实阶段、公开摘要和可重试错误处理。修正共享归并以保持正文不受状态影响；首次正文计时语义保持不变。

验收：初始化阻塞时先有状态；公开摘要有界合并；原始推理不出适配层；重试不误报失败、不重复输入；正文交错、重连、审批与终态无污染。Web/Electron 与 Mobile 共用状态映射，语言资源完整。

证据和复盘：执行后补充。
