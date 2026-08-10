# Grok 集成任务

## 目标

把 `grok.com` 作为第三个独立 Provider 接入现有 Node.js daemon、MV3 extension 和 Responses API。Grok 与 ChatGPT、Gemini 共享协议和调度架构，但拥有独立 worker 池、登录态、动态能力和会话路由。

## 范围

- `grok/default` 与账号可见的动态模型
- 动态推理模式发现与切换
- 文本、SSE 流式和 `previous_response_id` 多轮续接
- 图片输入与图片生成
- 函数调用及 `function_call_output` 回传
- popup 独立状态、诊断和标签页数量
- 专用系统 Chrome Profile 与真实 E2E

## 任务

- [x] 扩展共享 Provider、Native Messaging 和 daemon 配置协议
- [x] 增加 Grok 独立 scheduler、worker 生命周期和会话路由
- [x] 实现 Grok DOM adapter 与 content script
- [x] 增加 popup 配置和诊断
- [x] 增加单元测试、扩展 E2E、daemon E2E 和 Responses API fixture E2E
- [x] 增加 `~/.web2api/grok-profile` setup 与真实 smoke 测试
- [ ] 使用已登录专用 Profile 跑通真实 Grok smoke 5 项验收（当前账号的 Imagine 返回额度升级页，图片生成项被外部账号限制阻断）

## 验收门槛

```sh
pnpm test
pnpm typecheck
pnpm test:e2e:extension
pnpm test:e2e:extension-daemon
pnpm test:e2e:extension-responses
pnpm test:smoke:grok
```

前五项必须全绿。最后一项必须在真实 `grok.com`、真实账号和当前构建扩展上完成，不允许 skip，也不能用 fixture 结果替代。
