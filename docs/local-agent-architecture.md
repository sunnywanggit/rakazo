# Rakazo 本机 Codex 接入架构图

以下九张 Mermaid 图对应当前实现，覆盖组件、配对、执行、审批、状态、恢复、停止、权限和数据关系。它们描述代码行为；本机启用与部署步骤见 [操作指南](local-agent.md)。

## 1 整体架构与信任边界

客户端统一通过 Rakazo 后端操作。后端与本机桥接使用配对令牌，本机桥接与 Codex 使用 stdio JSON RPC。Codex 的账户认证保留在本机；模型推理由本机 CLI 按其认证访问模型服务，不能把“本机执行”理解为“模型推理也在本机”。

```mermaid
flowchart LR
    subgraph Clients[客户端]
        Web[Web]
        Desktop[Electron 中的共享 Web UI]
        Mobile[Expo Mobile 原生 UI]
    end

    subgraph Server[Rakazo 后端]
        API[认证 RPC API]
        DB[(Postgres<br/>RLS 与内容加密)]
        Secrets[SecretStore<br/>保存桥接令牌]
        Jobs[JobPublisher<br/>内存队列或 Graphile]
        Executor[RunExecutor<br/>按 Bot 执行来源分派]
        Coordinator[LocalAgentCoordinator<br/>租约与 fence 游标 交互恢复]
        Runtime[LocalAgentRuntime 与 Client<br/>中立请求及事件契约]
        Existing[既有 AgentRuntime<br/>既有沙箱 Provider]
        Live[既有实时事件通道]
    end

    subgraph Mac[本机 Mac]
        Config[私密配置<br/>项目 ID 到规范目录的映射<br/>账户与 Bot 授权绑定]
        Host[Local Agent Host<br/>Bearer 校验 Host 校验<br/>拒绝浏览器 Origin]
        Journal[(私密日志<br/>run 事件 会话引用 取消记录)]
        Driver[CodexAppServerEngine<br/>原生协议翻译与策略核验]
        Owner[独立进程所有者<br/>父进程消失时清理进程组]
        CLI[codex app-server<br/>原生 thread 与 turn]
        Auth[CLI 本机认证]
        Project[已授权项目目录<br/>read 或 write]
    end

    Model[模型服务]
    Web --> API
    Desktop --> API
    Mobile --> API
    API --> DB
    API --> Secrets
    API --> Jobs
    Jobs --> Executor
    Executor -->|本机 Bot| Coordinator
    Executor -->|普通 Bot| Existing
    Coordinator --> DB
    Coordinator --> Runtime
    Runtime -->|后端允许的精确 origin<br/>Bearer HTTP 与 NDJSON| Host
    Config --> Host
    Host <--> Journal
    Host --> Driver
    Driver --> Owner
    Owner -->|启动并持有进程| CLI
    Driver <-->|stdio JSON RPC| CLI
    Auth --> CLI
    CLI -->|受原生沙箱约束的本机工具| Project
    CLI -->|CLI 自己的模型认证| Model
    Coordinator --> Live
    Live --> API
    API -->|已提交的消息与进度| Web
    API -->|已提交的消息与进度| Desktop
    API -->|已提交的消息与进度| Mobile
```

`SecretStore` 中的配对令牌与 Codex 本机认证是两类凭据。客户端没有直连本机桥接或原生 Codex RPC 的控制通道；初次配对时，用户通过登录后的设置表单将配对令牌交给后端。

## 2 配对与执行来源选择

`LOCAL_AGENT_ALLOWED_ORIGINS` 由部署者配置，默认关闭入口。需要先更新所有 API 和 Worker，再允许创建本机执行目标。连接探测返回项目和模型目录；具体账户、Bot、项目的本机授权绑定还会在每次启动任务时校验。

```mermaid
sequenceDiagram
    actor User as 用户与本机操作者
    participant UI as 任一客户端设置页
    participant API as Rakazo API
    participant Store as SecretStore
    participant DB as Postgres
    participant Host as 本机桥接
    participant CLI as Codex CLI

    User->>UI: 打开 Bot 高级设置
    UI->>API: localAgent.settings(botId)
    API->>DB: 校验 Bot 属于当前用户与 Space
    API-->>UI: 连接摘要与 pairing IDs
    User->>Host: 在本机写入私密配置并启动服务
    Note over User,Host: 随机配对令牌 项目根目录 访问上限 与 scope 绑定
    User->>UI: 输入桥接 endpoint 与配对令牌
    UI->>API: localAgent.connect
    API->>API: 精确 origin 白名单与输入校验
    API->>Host: GET /v1/capabilities + Bearer
    Host->>CLI: 检查版本 初始化 隔离策略 account/read model/list
    CLI-->>Host: 认证可用状态与模型目录
    Host-->>API: engine projects models
    API->>Store: 保存配对令牌
    API->>DB: 事务写入 Secret 与 Connection
    API-->>UI: connectionId
    Note over UI: 令牌输入框在提交时清空
    User->>UI: 选择连接 项目 模型 读写权限
    UI->>API: localAgent.setTarget
    API->>Host: 再次获取可用项目与模型
    API->>API: 核验项目权限上限与模型
    API->>DB: 锁住 thread 检查没有活动任务
    alt 仍有活动任务
        API-->>UI: 拒绝修改 请先停止任务
    else 可以修改
        API->>DB: 保存 Target 与新的 revision
        API-->>UI: 执行来源已保存
    end
```

## 3 一次任务与后续连续对话

业务 Run、本机 run 和 Codex turn 分属不同层。恢复一个业务 Run 不会创建新的原生 turn；用户主动发送下一条消息，才会在同一原生 thread 中启动下一轮 turn。

```mermaid
sequenceDiagram
    participant UI as Web Electron 或 Mobile
    participant API as Rakazo API
    participant DB as Postgres
    participant Q as 任务队列
    participant W as Worker 与本机 Coordinator
    participant H as 本机桥接与 Codex 驱动
    participant C as codex app-server
    participant RT as 既有实时通道

    UI->>API: threads.send(botId, text)
    API->>DB: 保存用户消息 Task 与 queued Run
    API->>Q: run.continue(runId)
    Q->>W: 分派任务
    W->>DB: 判断 NativeRun 或 Bot Target 是否存在
    Note over W: 普通 Bot 返回既有执行路径
    W->>DB: 锁 thread CAS 取得租约 fence 加一 创建 Attempt
    W->>DB: 查找或创建 Session 保存不可变 Request 快照
    Note over DB: Session 绑定账户 Space Bot thread 连接 项目 模型 access generation
    W->>H: POST /v1/runs(scope, runId, sessionId, projectId, fence)
    H->>H: 校验令牌 Host scope 项目 access 与请求摘要
    H->>H: 检查取消记录 并发冲突与容量
    H->>H: 原子写入 run 日志后启动原生执行
    H->>C: initialize 与有效策略检查
    alt 首次使用该 Session
        H->>C: thread/start
    else 已保存原生会话引用
        H->>C: thread/resume
    end
    C-->>H: threadId 与实际生效策略
    H->>H: 核验策略 保存私密原生会话引用
    H->>C: turn/start 只提交本轮输入
    W->>H: GET /v1/runs/runId/events?after=cursor
    loop 文本与活动事件
        C-->>H: 原生通知
        H->>H: 转换中立事件 分配 sequence 写日志
        H-->>W: NDJSON envelope
        W->>DB: 同一事务校验 fence 写进度或输出 更新 cursor
        W->>RT: 发布已提交事件
        RT-->>UI: 流式进度与消息
    end
    Note over W,H: 运行期间每 5 秒续约 业务与本机执行租约为 90 秒
    C-->>H: turn/completed
    H->>H: 持久化 terminal 事件
    H-->>W: terminal completed
    W->>DB: 保存 terminalStatus 并通过既有 finalizeRun 收尾
    W->>RT: 发布完成事件 按用户偏好发送通知
    RT-->>UI: 最终消息与完成状态
    Note over UI,C: 下一条明确的新消息产生新 Run 和新 turn 复用同一 Session 的原生 thread
```

## 4 审批与结构化问答

只有适用且有界的原生文件变更审批会进入“允许一次/拒绝”卡片；命令提权和扩大权限请求直接拒绝。普通聊天文本和通用 `threads.answer` 不能代替专用交互接口。

```mermaid
sequenceDiagram
    actor User as 任务所有者
    participant UI as 授权或问答卡片
    participant API as Rakazo API
    participant DB as Postgres
    participant Q as 任务队列
    participant W as Worker
    participant H as 本机桥接与驱动
    participant C as Codex 原生 turn

    C->>H: 文件审批或 blocking requestUserInput
    H->>H: 校验原生 thread 与 turn 以及请求边界
    H->>H: 创建 interactionId 保留原始 RPC 引用
    H->>H: 持久化 interaction 事件与 15 分钟截止时间
    H-->>W: interaction envelope
    W->>DB: 同一事务保存 Interaction 卡片 cursor
    W->>DB: Run 变为 waiting_input 并释放 Worker 租约
    W-->>UI: 通过既有实时通道呈现卡片
    Note over W,C: Worker 消费结束 Codex 进程仍在等待原始 RPC 的响应
    User->>UI: 允许一次 拒绝 或填写每个结构化问题
    UI->>API: localAgent.respond(interactionId, messageId, decision, answers)
    API->>DB: 校验当前用户 Space 连接 任务 卡片及过期时间
    alt 越权 过期或冲突响应
        API-->>UI: 拒绝 无原生动作
    else 有效的首次响应
        API->>DB: 事务 CAS 保存决定 卡片已回答 Run 重新 queued
        API->>Q: run.continue 同一 runId
        Q->>W: 新 Attempt 与新 fence
        W->>DB: 读取持久化决定及 cursor
        W->>H: GET 原 run 确认日志存在
        W->>H: POST 同一 run 与新 fence 幂等关联
        W->>H: POST interaction 响应
        H->>H: 校验当前 fence 和 interaction 保存决定
        H->>C: 用原 RPC ID 回送 accept decline 或 answers
        H->>H: 持久化 resolved 事件
        H-->>W: 从原 cursor 继续返回事件
        W->>DB: Interaction 更新为 delivered 并推进 cursor
        C-->>H: 继续原 turn 或完成
    end
    Note over API,H: 相同决定可幂等重试 冲突决定被拒绝 不创建第二次原生响应
```

## 5 Rakazo 业务 Run 状态

本图只表示业务 Run。桥接日志的 `uncertain` 通过失败收尾及错误信息呈现；它不是新增的业务 Run 状态。桥接返回 `cancelled` 时，通用执行收尾也可能记为业务失败；用户执行 Stop 并得到本机确认后，走业务 `cancelled` 路径。

```mermaid
stateDiagram-v2
    [*] --> queued: 消息入库并提交任务
    queued --> running: CAS 获得执行租约并增加 fence
    running --> waiting_input: 事务保存原生交互与卡片
    waiting_input --> queued: 真人决定已提交
    waiting_input --> queued: 调和器发现原生任务结束或交互到期
    running --> queued: 有界传输重试或项目忙
    running --> queued: Worker 正常关闭后交接
    running --> completed: 原生 completed 已持久化并收尾
    running --> failed: 原生失败或不确定或无法安全恢复
    queued --> cancelled: 本机确认 Stop
    running --> cancelled: 本机确认 Stop
    waiting_input --> cancelled: 本机确认 Stop
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
```

## 6 重启与断线恢复

幂等关联使用相同 runId 和不可变请求，新 Worker 只更新 fence。第一次创建、以及已确认因项目忙而未创建的请求，可以创建本机任务；其他恢复路径必须先找到原本机任务记录。

```mermaid
flowchart TD
    Cause{恢复原因}
    Cause -->|API 或 Worker 正常关闭| Release[保留本机 turn<br/>释放业务租约并重新 queued]
    Cause -->|网络或心跳传输中断| Retry{仍持有业务租约<br/>且传输重试未耗尽?}
    Retry -->|是| Backoff[5 秒后重新排队<br/>最多 3 次传输重试]
    Retry -->|否| StopSafe[停止本次消费<br/>按所有权与错误路径安全收尾]
    Cause -->|旧 Worker 失去业务 fence| Old[停止旧消费者<br/>禁止它提交后续业务事件]
    Release --> Claim[新 Attempt 取得新 fence<br/>读取同一 runId Request cursor 决定]
    Backoff --> Claim
    Claim --> Receipt{原本机 run 日志存在?}
    Receipt -->|不存在| Missing[拒绝重新提交任务<br/>业务失败并提示无法确认执行结果]
    Receipt -->|存在| Attach[POST 同一 run 与新 fence<br/>只关联既有执行]
    Attach --> Stream[读取 sequence 大于 cursor 的事件<br/>补发已保存且尚未交付的决定]
    Stream --> Order{事件序号}
    Order -->|已消费的重复事件| Skip[跳过重复 不重复落库]
    Skip --> Stream
    Order -->|下一个连续序号| Commit[同一事务保存事件与 cursor]
    Commit --> Result{事件或本机状态}
    Result -->|继续运行| Stream
    Result -->|等待交互| Wait[保存卡片 释放 Worker 租约]
    Result -->|已有终态| Finalize[按已保存终态收尾]
    Order -->|存在缺口| Gap[拒绝静默补齐<br/>安全失败]
    Cause -->|本机桥接重启| HostBoot[加载私密日志<br/>未完成记录追加 uncertain]
    Cause -->|桥接进程退出| Owner[原桥接消失时<br/>独立所有者清理其原生进程组]
    HostBoot --> Reconcile[等待任务调和器每 30 秒检查<br/>或运行任务由 Worker 重新关联]
    Reconcile --> Claim
```

进程所有者在父桥接进程消失时独立执行清理；图中它与日志恢复是同一故障的两个处理分支，不依赖新的桥接实例去寻找或杀死系统中的其他 Codex 进程。

## 7 Stop 与启动竞态

UI 的 Stop 使用 `POST /v1/cancellations`，携带完整 scope、runId 和 projectId。它与旧 Worker 使用的带 fence `/cancel` 是不同入口。即便 Worker 还没启动本机任务，也会先写取消记录。

```mermaid
sequenceDiagram
    participant UI as 任一客户端
    participant API as Rakazo API
    participant DB as Postgres
    participant H as 本机桥接
    participant C as 本服务创建的 Codex 进程
    participant W as 可能晚到的 Worker

    UI->>API: threads.stop
    API->>DB: 读取当前用户的活动 Run 与固定执行目标
    API->>H: POST /v1/cancellations(scope, runId, projectId)
    alt 本机不可达或取消未被确认
        H--xAPI: 超时或连接失败
        API-->>UI: Stop 未确认 可重试
        Note over API,DB: 不提前把业务任务标成已停止
    else 取消请求被本机接受
        H->>H: 校验 scope 与项目 原子保存取消记录
        alt 原生进程已经存在
            H->>H: 中止启动流程并记录 cancelled
            H->>C: 尝试 turn/interrupt 有界等待
            H->>H: 清理本服务持有的进程组
        else 本机任务尚未创建
            Note over H: 保留取消记录 等待拦截晚到的启动请求
        end
        H-->>API: 返回确认的终态
        API->>DB: 既有 stopThreadRuns 提交业务取消及相关事件
        API-->>UI: 任务已停止
        W->>H: 可能晚到的 POST /v1/runs
        H->>H: 命中取消记录
        H-->>W: cancelled 不启动新原生 turn
    end
```

清空会话、归档、删除和撤销连接也使用本机取消边界。撤销先禁用服务器连接，再确认相关任务停止；它不会自动轮换独立桥接进程的令牌。进程若早已完成，会保留其原有终态，取消不会撤销已经发生的文件修改。

## 8 原生权限与进程边界

项目写权限来自显式配置和 Bot 选择；并非每次项目内写入都需要一张审批卡片。下图中的审批分支只处理原生 CLI 实际发出的审批请求。

```mermaid
flowchart TD
    Input[后端的中立 Run 请求<br/>scope runId projectId model access fence]
    Input --> HostAuth{令牌 Host scope<br/>项目与权限均有效?}
    HostAuth -->|否| Deny[拒绝请求]
    HostAuth -->|是| Root[项目 ID 映射到规范绝对目录<br/>拒绝替换根目录的符号链接]
    Root --> Env[固定 CLI 可执行文件<br/>仅继承允许的环境变量]
    Env --> Version{CLI 协议属于已审阅的 0.163 系列?}
    Version -->|否| Fail[拒绝启动或安全失败]
    Version -->|是| Init[启动受持有的 app-server<br/>initialize 与 config/read]
    Init --> Ambient{存在活动的环境 MCP 配置?}
    Ambient -->|有| Disable[逐项禁用并重启检查一次]
    Disable --> Verify
    Ambient -->|无| Verify[核验最终配置<br/>关闭插件 hooks 浏览器 电脑与子代理等功能<br/>核验文件系统与命令网络策略]
    Verify --> Account[account/read<br/>认证只由本机 CLI 管理]
    Account --> Thread[thread/start 或 thread/resume<br/>检查实际 cwd 根目录与权限 profile]
    Thread --> Turn[turn/start]
    Turn --> Tools[原生工具在有效沙箱中执行<br/>项目范围与 read 或 write 上限]
    Tools -->|读取环境文件或越出项目权限| SandboxDeny[原生沙箱拒绝]
    Tools -->|CLI 发出审批请求| Request{原生请求类型}
    Request -->|命令提权或扩大权限| Decline[直接拒绝 不发放额外权限]
    Request -->|文件变更审批| Bounds{write 模式且项目内<br/>无额外 grantRoot<br/>变更数量与完整预览有界<br/>真实路径及受保护目录检查通过?}
    Bounds -->|否| Decline
    Bounds -->|是| Human[专用本机授权卡片<br/>允许一次或拒绝]
    Request -->|阻塞式非秘密问题| Questions[结构化问答卡片]
    Verify -->|策略无法核验| Fail
    Thread -->|实际策略不一致| Fail
    Turn -.-> Owner[独立进程所有者<br/>桥接 stdin 关闭时杀死自有进程组]
```

命令网络关闭针对原生工具的命令执行环境。CLI 自身与模型服务的认证通信仍存在。桥接只管理它创建的原生实例；不会导入或接管用户已经打开的 Codex 桌面聊天。

## 9 持久化关系与会话身份

为便于阅读，下图省略五张本机表各自到 User、Space 的直接外键；它们都有 `spaceId`、`userId`，并受租户 RLS 约束。`request`、`output`、`payload` 和 `decision` 走现有内容加密层，配对凭据走 SecretStore。

```mermaid
erDiagram
    Bot ||--o| LocalAgentTarget : "当前执行目标"
    LocalAgentConnection ||--o{ LocalAgentTarget : "连接被 Bot 选择"
    Secret ||--o{ LocalAgentConnection : "配对凭据记录"
    LocalAgentConnection ||--o{ LocalAgentSession : "会话固定连接"
    Bot ||--o{ LocalAgentSession : "Bot 的历史会话"
    Thread ||--o{ LocalAgentSession : "聊天的历史会话"
    LocalAgentSession ||--o{ LocalAgentRun : "多轮任务复用"
    Run ||--o| LocalAgentRun : "共享 runId"
    Thread ||--o{ LocalAgentRun : "所属聊天"
    LocalAgentRun ||--o{ LocalAgentInteraction : "任务内交互"
    Thread ||--o{ LocalAgentInteraction : "卡片所属聊天"

    LocalAgentConnection {
        string id PK
        string spaceId FK
        string userId FK
        string endpoint
        string secretId FK
        boolean enabled
    }
    LocalAgentTarget {
        string botId PK,FK
        string spaceId FK
        string userId FK
        string connectionId FK
        string projectId
        string model
        string access
        string revision
    }
    LocalAgentSession {
        string id PK
        string spaceId FK
        string userId FK
        string botId FK
        string threadId FK
        string connectionId FK
        string projectId
        string model
        string access
        string generation
    }
    LocalAgentRun {
        string id PK,FK
        string spaceId FK
        string userId FK
        string threadId FK
        string sessionId FK
        string request "加密的不可变请求"
        string output "加密的累计输出"
        int cursor "已提交的原生事件序号"
        int hostFence "关联时的执行代次"
        string terminalStatus
    }
    LocalAgentInteraction {
        string id PK
        string spaceId FK
        string userId FK
        string runId FK
        string threadId FK
        string payload "加密的交互内容"
        string decision "加密的人类决定"
        string status "pending decided delivered expired"
        datetime expiresAt
    }
```

会话唯一身份是 `spaceId + userId + botId + threadId + connectionId + projectId + model + access + generation`。其中 `generation` 由聊天历史代次和 Target revision 组合；清空历史或改变执行目标后，不会接着复用先前的会话绑定。原生 thread 引用保存在本机私密状态目录，不直接交给客户端。

## 实现入口

| 图中组件 | 源文件 |
| --- | --- |
| 中立契约 | [local-agent.ts](../packages/contracts/src/local-agent.ts) |
| 连接与 Bot 目标 | [local-agent-settings.ts](../packages/adapters/src/local-agent-settings.ts) |
| 后端调度与恢复 | [local-agent-coordinator.ts](../packages/adapters/src/local-agent-coordinator.ts) |
| 中立 Runtime | [local-agent-runtime.ts](../packages/adapters/src/local-agent-runtime.ts) |
| 桥接 HTTP 客户端 | [local-agent-client.ts](../packages/adapters/src/local-agent-client.ts) |
| 本机桥接与日志 | [local-agent-host.ts](../packages/adapters/src/local-agent-host.ts) |
| Codex 协议驱动 | [codex-app-server.ts](../packages/adapters/src/codex-app-server.ts) |
| 事件与游标事务 | [local-agent-events.ts](../packages/db/src/local-agent-events.ts) |
| 多端共享设置状态 | [local-agent-settings.ts](../packages/chat-ui/src/local-agent-settings.ts) |
| 本机进程入口 | [index.ts](../apps/local-agent/src/index.ts) |
