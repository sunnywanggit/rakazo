# 生命周期、计时与发现缓存

- Parent: [local-agent-responsiveness](INDEX.md)
- Change: local-agent-responsiveness
- Task: LAR-RESP-02
- Design: [local-agent-responsiveness](../../design/local-agent-responsiveness.md)
- 状态：待执行
- 依赖：LAR-RESP-01

交付设计第 4.2、4.3、5、6 节对应基础能力。扩展中立引擎生命周期，认证能力协商与幂等释放，协调清空、归档、删除、目标变更与撤销。增加单调阶段计时、带身份失效的版本和模型目录短缓存；复用默认关闭。

验收：旧 Host 404 正常降级；旧请求不启用复用；越权或变更绑定释放被拒绝；释放与启动按代次隔离；不泄漏原生引用与账号；发现查询合并、过期和失效正确，错误不缓存。

证据和复盘：执行后补充。
