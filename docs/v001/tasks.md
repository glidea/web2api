！！！每完成一个任务并且验证通过之后就commit一下！！固定提醒

# Task-001: 建立 WXT 扩展与自动安装 E2E 骨架

## 描述
参考 OPCStack 建立 WXT + MV3 + TypeScript + Svelte 工程。使用 Playwright Chromium 自动加载 unpacked 扩展，并验证 Service Worker、Content Script 和 popup 三个入口真实运行。

## 不包含
- ChatGPT DOM 操作
- daemon
- Responses API

## TODO 清单
- [ ] 1. 建立 pnpm、WXT、TypeScript、Vitest 和 Playwright 配置
- [ ] 2. 创建 background、content script 和 popup 最小入口
- [ ] 3. 创建 Playwright persistent context 扩展 fixture
- [ ] 4. 使用 route fixture 模拟 `chatgpt.com` 页面

## 验收测试步骤
1. 运行 `pnpm test:e2e:extension`
2. 测试自动构建并加载 MV3 扩展，取得 extension ID
3. 断言 popup 可打开、Content Script 只注入 `chatgpt.com`、Service Worker 可收发消息

---

# Task-002: 验证 ChatGPT DOM Adapter 五个硬点

## 描述
先用 fixture 测试实现单一 ChatGPT Adapter，再用专用持久化 Chromium profile 执行真实网页 smoke test。五个硬点任一失败就回到技术设计，不继续 daemon。

## 不包含
- 公共 HTTP API
- 多标签页 Scheduler
- OpenAI Responses 格式转换

## TODO 清单
- [ ] 1. 测试并实现后台 tab 的 DOM 增量读取与完成检测
- [ ] 2. 测试并实现 conversation ID 识别
- [ ] 3. 测试并实现 `File` + `DataTransfer` 图片上传
- [ ] 4. 测试并实现模型与 reasoning effort 扫描和切换
- [ ] 5. 测试并实现最终生成图片字节提取
- [ ] 6. 记录真实网页 smoke test 结果和失败证据

## 验收测试步骤
1. 运行 DOM fixture 单元测试并确认全部通过
2. 在专用 Chromium profile 登录 ChatGPT 后运行 `pnpm test:smoke:chatgpt`
3. 确认五项能力全部通过；任一失败时任务不得标记完成

---

# Task-003: 实现 Node.js daemon CLI 与健康检查

## 描述
实现可通过 `npx web2api start` 启动的 Node.js + TypeScript 本地服务。首次启动生成配置和 API key，只提供认证、`/healthz` 与清晰的终端状态。

## 不包含
- `/v1/responses`
- Chrome worker 管理
- 系统后台服务安装

## TODO 清单
- [ ] 1. 先写 CLI 启动与 HTTP E2E 测试
- [ ] 2. 实现配置文件、固定端口和 API key 生成
- [ ] 3. 实现 `GET /healthz` 与 Bearer 认证中间逻辑
- [ ] 4. 输出 base URL、API key 和扩展连接状态

## 验收测试步骤
1. 在空配置目录运行 `pnpm web2api start`
2. `curl http://127.0.0.1:3210/healthz` 返回 daemon ready、extension disconnected
3. 第二次启动复用同一 API key；端口占用时明确失败且不自动换端口

---

# Task-004: 建立 daemon 与扩展连接及单 worker 生命周期

## 描述
实现 Extension WebSocket Gateway、heartbeat 和 typed message schema。扩展维护一个自己创建的 ChatGPT tab，并把 ready、unhealthy 和关闭状态报告给 daemon。

## 不包含
- Prompt 提交
- Responses 输出
- 多标签页并发

## TODO 清单
- [ ] 1. 先写握手、心跳和断线 E2E 测试
- [ ] 2. 定义共享 WebSocket schema 和协议版本
- [ ] 3. 实现 daemon Extension Gateway
- [ ] 4. 实现 Service Worker 自动连接和单 worker tab 生命周期
- [ ] 5. 在 popup 展示 daemon、登录和 worker 状态

## 验收测试步骤
1. 启动 daemon 和 Playwright 扩展 E2E
2. `/healthz` 从 extension disconnected 变为 connected、worker ready
3. 关闭 worker tab 后状态变为 unhealthy，并按规则补建空闲 worker

---

# Task-005: 打通非流式文本 Responses 闭环

## 描述
实现第一条真实业务链路：本地客户端调用 `POST /v1/responses`，扩展在单个 ChatGPT 页面提交文本，daemon 返回非流式 Response JSON。只支持 `chatgpt/default`。

## 不包含
- SSE 流式输出
- 多轮续接
- 模型切换
- 图片

## TODO 清单
- [ ] 1. 先写 daemon 到假扩展的非流式 E2E 测试
- [ ] 2. 实现 Responses 请求 schema 和标准错误格式
- [ ] 3. 实现单 worker RequestTask 执行链路
- [ ] 4. 实现页面文本提交、最终文本读取和 conversation 绑定
- [ ] 5. 实现最终 Response JSON 投影

## 验收测试步骤
1. 使用官方 OpenAI SDK，把 `base_url` 指向本地 daemon
2. 发送 `chatgpt/default` 文本请求
3. 返回包含有效 `response.id` 和最终文本；未登录时返回 `chatgpt_login_required`

---

# Task-006: 支持流式文本与客户端取消

## 描述
在同一内部事件流上增加 typed SSE 投影。客户端断开时下发 `job.cancel`，Content Script 点击页面停止按钮并释放 worker。

## 不包含
- 多标签页并发
- 图片 partial events
- 请求结果找回

## TODO 清单
- [ ] 1. 先写 SSE 顺序和断开取消 E2E 测试
- [ ] 2. 实现 assistant 文本非回滚增量提取
- [ ] 3. 实现完整 Responses SSE 生命周期事件
- [ ] 4. 实现 HTTP 断开到页面停止的取消链路

## 验收测试步骤
1. 发送 `stream: true` 请求并逐帧读取 SSE
2. 事件顺序符合技术设计，delta 拼接等于最终文本
3. 中途关闭客户端连接后网页停止生成，worker 回到 ready

---

# Task-007: 支持多轮会话与可配置标签页并发

## 描述
实现 response ID 编解码、`previous_response_id`、FIFO Scheduler、conversation lock 和固定 worker 池。默认两个标签页，不同对话并行，同一对话串行。

## 不包含
- 模型与 effort 切换
- 图片
- 持久化任务队列

## TODO 清单
- [ ] 1. 先写多轮、同会话串行和跨会话并行 E2E 测试
- [ ] 2. 实现 response ID 编解码
- [ ] 3. 实现 Scheduler、conversation lock 和 worker lease
- [ ] 4. 实现扩展固定 tab pool 与导航重绑定
- [ ] 5. 支持 `max_tabs` 配置

## 验收测试步骤
1. 使用首轮 `response.id` 发起续接并确认进入同一 ChatGPT conversation
2. 同时提交 A1、A2、B1，确认 A2 等待 A1，B1 可与 A1 并行
3. 手动关闭 busy tab，确认当前任务失败且不会在另一 tab 自动重试

---

# Task-008: 支持动态模型与思考等级

## 描述
扩展扫描当前账号真实可见的模型与 effort，daemon 通过 `/v1/models` 暴露动态目录。显式选择无法映射时必须在提交 prompt 前失败。

## 不包含
- 固定维护 ChatGPT 模型表
- 自动降级模型或 effort
- 图片能力

## TODO 清单
- [ ] 1. 先写 capability 更新和严格映射测试
- [ ] 2. 实现模型与 effort DOM 扫描
- [ ] 3. 实现 `capabilities.updated` 与动态 `/v1/models`
- [ ] 4. 实现提交前模型和 effort 切换

## 验收测试步骤
1. `GET /v1/models` 返回 `chatgpt/default` 和页面可见模型
2. 选择一个可用模型与 effort，确认页面选项实际改变后再提交
3. 请求不存在的值，确认返回 400 且 ChatGPT 页面没有新增消息

---

# Task-009: 支持图片输入、编辑与生成

## 描述
实现 HTTP(S) URL 和 base64 data URL 图片输入、多图顺序上传、文本生图、图片编辑及最终 base64 输出。整个链路仍使用真实 ChatGPT 页面控件。

## 不包含
- Files API 和 `file_id`
- partial image events
- 图片持久化和缓存

## TODO 清单
- [ ] 1. 先写 URL、data URL、多图和生图 E2E 测试
- [ ] 2. 实现 daemon Image Resolver
- [ ] 3. 实现逐图 WebSocket 传输与附件 ready 确认
- [ ] 4. 实现文本生图和图片编辑提交
- [ ] 5. 实现最终图片字节提取与 `image_generation_call.result`

## 验收测试步骤
1. 分别用 data URL 和 HTTP URL 编辑图片，确认结果可解码
2. 上传两张图片，确认页面预览和处理顺序与请求一致
3. 执行纯文本生图；超限图片在提交前失败且不写临时文件

---

# Task-010: 完成 npm 分发与发布验收

## 描述
把 daemon 发布形态收口为 npm CLI，并把 WXT 扩展产物、配置说明和真实网页 smoke test 串成发布检查。后台服务安装和 Node SEA 只做评估，不阻塞首个 npm 版本。

## 不包含
- Chrome Web Store 实际上架审批
- 自动绕过登录、CAPTCHA 或风控
- 强制安装系统后台服务

## TODO 清单
- [ ] 1. 验证 npm pack 后的 `npx web2api start`
- [ ] 2. 生成 WXT Chrome zip 并校验 manifest 权限
- [ ] 3. 完成 popup 连接、登录、worker 和模型诊断
- [ ] 4. 建立一条发布前真实 ChatGPT smoke test 命令
- [ ] 5. 记录后台服务与 Node SEA 的后续决策，不实现未验证方案

## 验收测试步骤
1. 在无源码目录安装本地 npm tarball 并启动 daemon
2. 加载扩展 zip，使用 OpenAI SDK 完成文本、多轮、并发、模型和图片测试
3. 检查默认日志不包含 prompt、response、图片、API key 或 ChatGPT 凭据
