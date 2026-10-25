# 有界复用与综合验收

- Parent: [local-agent-responsiveness](INDEX.md)
- Change: local-agent-responsiveness
- Task: LAR-RESP-03
- Design: [local-agent-responsiveness](../../design/local-agent-responsiveness.md)
- 状态：待执行
- 依赖：LAR-RESP-02

交付设计第 4.1 节，在完整生命周期基础上启用同一绑定的可选短期复用。验证代次、授权、账号、配置与项目身份，限制空闲 TTL/LRU，逐轮重新验证实际权限。补充综合验收和用户操作文档。

验收：连续两轮一次启动与初始化，无重复恢复；不同绑定不能复用；TTL/LRU、变更、取消、审批超时、异常退出和重启清理正确；迟到事件不串轮次；不确定输入不重发。相关离线、类型和 lint 检查通过，按真实证据报告收益与限制。

证据和复盘：执行后补充。
