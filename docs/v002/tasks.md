！！！每完成一个任务并且验证通过之后就commit一下！！固定提醒

# Gemini 集成任务计划

## 已确认范围

- ChatGPT 与 Gemini 同时在线，通过 `chatgpt/*`、`gemini/*` 路由
- 两个 Provider 分别配置标签页数量，分别调度，不共享 worker
- Gemini 支持文本、SSE 流式、多轮续接、动态模型、图片输入、图片生成和函数调用
- 不保存或复制浏览器凭据，真实验收使用独立 Chrome profile
- 不保留 `max_tabs` 等旧配置兼容逻辑

## 当前状态

工作区已有 Task-001 的部分未提交修改，包括 Provider 协议、配置、调度、response ID 和验收测试。继续执行时先完成 Task-001 并恢复全部相关测试，再提交，不拆出无法运行的中间提交。

---

# Task-001: 建立双 Provider 核心契约与隔离调度

## 描述
把 daemon、Native Messaging 和共享协议从 ChatGPT 单 Provider 改为显式双 Provider。模型前缀决定路由，response ID 携带 Provider，同一对话只在所属 Provider 的 worker 池内调度。

## 不包含
- Gemini DOM Adapter
- Gemini Content Script
- popup 视觉改版

## TODO 清单
- [x] 1. 为 Provider 解析、跨 Provider 续接拒绝和独立调度补充失败测试
- [x] 2. 用 `chatgpt_tabs`、`gemini_tabs` 替换 `max_tabs`
- [x] 3. 给 worker、job 和 response ID 增加显式 Provider
- [x] 4. 实现 ChatGPT、Gemini 两个独立 Scheduler 和能力目录
- [x] 5. 更新 Native Messaging 与 CLI 配置协议
- [x] 6. 更新现有 ChatGPT background 握手，保证旧功能继续通过

## 验收测试步骤
1. 运行 `pnpm vitest run tests/config.test.ts tests/response-id.test.ts tests/gateway.test.ts tests/responses.test.ts tests/native-controller.test.ts tests/native-cli.test.ts`
2. 确认 Gemini 请求只进入 Gemini worker，ChatGPT 请求只进入 ChatGPT worker
3. 用 Gemini response ID 续接 ChatGPT 模型，确认请求在进入浏览器前返回 400
4. 运行 `pnpm typecheck`，确认不存在 `max_tabs`、`maxTabs` 和 Provider 隐式推断

---

# Task-002: 实现可独立测试的 Gemini DOM Adapter

## 描述
新增单一 Gemini Adapter，负责登录判断、conversation ID、动态模型扫描和切换、输入提交、增量文本、图片上传、生成图片读取及取消。Adapter 只依赖原生 DOM API，不包含扩展消息协议。

## 不包含
- daemon 调度
- Content Script 消息处理
- popup 状态展示

## TODO 清单
- [x] 1. 用真实 DOM 结构 fixture 写 Gemini Adapter 失败测试
- [x] 2. 实现 `/app/<conversation_id>` 解析和登录状态判断
- [x] 3. 实现当前账号可见模型的动态扫描与严格切换
- [x] 4. 实现 contenteditable composer 提交和文本增量读取
- [x] 5. 实现 `File` + `DataTransfer` 图片上传与附件就绪确认
- [x] 6. 实现最终生成图片提取和停止生成

## 验收测试步骤
1. 运行 `pnpm vitest run tests/gemini-adapter.test.ts`
2. fixture 中切换模型后，断言页面真实选项发生变化再提交 prompt
3. 断言文本 delta 只增不退，图片结果可解码为 PNG
4. 缺少登录态或模型不可用时明确失败，不提交 prompt

---

# Task-003: 打通 Gemini 文本、流式与多轮扩展链路

## 描述
新增 Gemini Content Script，并把 background 改为维护两组固定 worker tabs。先打通 Gemini 文本业务链路，同时保证 ChatGPT 与 Gemini 可以并行执行且互不导航到对方会话。

## 不包含
- 图片输入和图片生成验收
- popup 视觉与诊断
- 真实 Gemini 网页 smoke

## TODO 清单
- [x] 1. 写双 Provider MV3 E2E，定义 tab 生命周期和路由行为
- [x] 2. 注册 `https://gemini.google.com/*` Content Script 与 host permission
- [x] 3. 实现 Provider 独立的 tab 创建、恢复、关闭和 worker ready
- [x] 4. 接入 Gemini Adapter 的模型发现、提交、delta、完成和取消事件
- [x] 5. 支持 `gemini/default`、动态 `gemini/<model>` 与严格 reasoning effort
- [x] 6. 支持 Gemini `previous_response_id` 导航回同一 `/app/<id>` 会话

## 验收测试步骤
1. 运行 `pnpm test:e2e:extension-daemon`
2. 运行 `pnpm test:e2e:extension-responses`
3. 分别发送 ChatGPT、Gemini 非流式和 `stream: true` 请求，确认均返回正确内容
4. 同时发送两个 Provider 请求，确认各自 worker 并行工作且 conversation ID 不串线
5. 关闭一个 Gemini tab，确认只补建 Gemini worker，不影响 ChatGPT worker

---

# Task-004: 完成 Gemini 图片与函数调用能力

## 描述
复用现有 Responses Translator、Image Resolver 和函数提示词协议，把 Gemini 图片输入、图片生成和函数调用接入同一浏览器任务链路。Provider 只负责页面执行，不复制 daemon 业务协议。

## 不包含
- `/v1/files`
- Gemini 私有网络 API
- daemon 代替客户端执行函数

## TODO 清单
- [ ] 1. 为 Gemini 图片输入、图片生成和函数调用添加 E2E 失败测试
- [ ] 2. 把已解析图片按请求顺序上传到 Gemini 页面
- [ ] 3. 读取 Gemini 最终生成图片并返回 `image_generation_call.result`
- [ ] 4. 验证函数提示词结果转换为标准 `function_call`
- [ ] 5. 验证 `function_call_output` 使用原 Gemini conversation 续接
- [ ] 6. 验证流式函数调用不泄漏内部协议标记

## 验收测试步骤
1. 运行 `pnpm test:e2e:extension-responses`
2. 用 data URL 图片请求 Gemini，确认页面收到附件且返回文本
3. 请求 `image_generation`，确认结果 base64 可解码为真实图片
4. 完成一次 `function_call -> function_call_output -> 最终文本` 闭环
5. 重跑同等 ChatGPT 用例，确认公共 Translator 没有回归

---

# Task-005: 完成双 Provider popup 控制与诊断

## 描述
popup 分别展示 ChatGPT、Gemini 的登录、Content Script、worker、模型和标签页状态。配置保存时一次提交两个 Provider 的标签页数量并重启 daemon。

## 不包含
- Provider 开关
- 自动登录
- 历史配置迁移提示

## TODO 清单
- [ ] 1. 更新 popup typed protocol 和 background 状态聚合
- [ ] 2. 分别展示两个 Provider 的运行状态和动态模型
- [ ] 3. 提供两个独立的标签页数量输入
- [ ] 4. 保存配置后重启 daemon 并按新数量重建两个 worker 池
- [ ] 5. 保持 API Base URL、API key 和 daemon 控制入口不变

## 验收测试步骤
1. 运行 `pnpm test:e2e:extension`
2. 打开 popup，确认两个 Provider 状态均可独立识别
3. 把 ChatGPT 设为 1、Gemini 设为 3，保存后确认标签页数量分别为 1 和 3
4. Gemini 未登录时只显示 Gemini 登录问题，ChatGPT 状态保持正常

---

# Task-006: 建立真实 Gemini 独立 profile smoke 验收

## 描述
使用用户已登录的专用 Chrome profile 验证真实 Gemini 页面。setup 与 smoke 默认使用系统 Google Chrome，避免 bundled Chromium 被 Google 拒绝登录。

## 不包含
- 复制日常 Chrome Cookie
- 绕过 Google 风控、验证码或登录限制
- 固定维护 Gemini 模型表

## TODO 清单
- [ ] 1. 新增 Gemini profile setup 命令和 profile 路径约定
- [ ] 2. 新增真实 Gemini smoke Playwright 套件
- [ ] 3. 验证动态模型发现与一次真实模型切换
- [ ] 4. 验证文本、流式、多轮、图片输入、图片生成和函数调用
- [ ] 5. 根据真实 DOM 修正选择器，并同步回归 fixture
- [ ] 6. 在 `AGENTS.md` 记录真实 Gemini smoke 的凭据隔离规则

## 验收测试步骤
1. 使用 `/Users/wangyusong/.web2api/gemini-profile`，确认已登录 Gemini
2. 运行 `pnpm test:smoke:gemini`
3. smoke 必须直接调用本地 `/v1/responses`，不能只测试页面 Adapter
4. 七项能力全部通过；任一失败时不得把任务标记完成
5. 检查测试产物和日志不包含 Cookie、token、prompt 完整正文或图片原始内容

---

# Task-007: 收口文档与完整发布回归

## 描述
删除 ChatGPT 单 Provider 遗留命名，更新 README 和中文验收文档，执行完整测试矩阵。只有自动化与真实 Gemini smoke 都通过，才视为 Gemini 集成完成。

## 不包含
- Chrome Web Store 上架
- 新增第三个 Provider
- 为未来 Provider 提前抽象插件框架

## TODO 清单
- [ ] 1. 更新 README 的模型路由、配置、能力和 smoke 命令
- [ ] 2. 更新 `docs/acceptance.md` 的双 Provider 验收步骤
- [ ] 3. 全库删除 `max_tabs`、ChatGPT 专属通用错误码和重复 Provider 分支
- [ ] 4. 检查 manifest、npm pack 和 daemon bundle 内容
- [ ] 5. 运行完整 Vitest、TypeScript 和 Playwright 回归
- [ ] 6. 记录真实 Gemini 验收结果与已知网页 DOM 风险

## 验收测试步骤
1. 运行 `pnpm test`
2. 运行 `pnpm typecheck`
3. 运行 `pnpm test:e2e:extension`、`pnpm test:e2e:extension-daemon`、`pnpm test:e2e:extension-responses`
4. 运行 `pnpm test:smoke:chatgpt` 与 `pnpm test:smoke:gemini`
5. 运行 `pnpm pack --dry-run`，确认发布包包含 daemon 且不包含 profile、凭据和测试产物
6. 从 popup 修改两个 Provider 标签页数量后，用真实客户端分别完成 ChatGPT 与 Gemini 请求
