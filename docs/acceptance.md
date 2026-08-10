# Web2API 本地运行与验收

这里只保留从源码把项目跑起来的最短路径。

## 1. 安装依赖并构建

要求 Node.js 22+ 和 pnpm 10。

```sh
pnpm install
pnpm build:daemon
pnpm build:extension
```

## 2. 加载 Chrome 扩展

1. 打开 `chrome://extensions`
2. 开启 Developer mode
3. 点击 Load unpacked
4. 选择 `src/extension/.output/chrome-mv3`
5. 固定 Web2API 扩展并打开 popup

## 3. 一次性安装本地 Companion

popup 会显示带真实 Extension ID 的命令。源码开发时把命令中的 npm 调用替换为本地 CLI：

```sh
node bin/glidea-web2api.mjs install --extension-id <popup 中的 extension-id>
```

安装完成后回到 popup，点击 **Check again**。

正常结果：

- Companion 显示 Connected
- 分别打开配置数量的 ChatGPT、Gemini 和 Grok worker 标签页
- popup 展示 Base URL 和 API key
- 可以在 popup 启动、停止、重启 daemon
- ChatGPT、Gemini 与 Grok 分别展示登录态、Content Script、worker、动态模型和推理模式
- 修改任一 Provider 的标签页数量后保存，会重启 daemon 并独立调整三个 worker 池

如果 worker 页面未登录，直接在对应 Provider 页面登录。Web2API 不复制 Cookie，某个 Provider 未登录不会影响另一个 Provider。

## 4. 调用本地 API

从 popup 复制 API key：

```sh
export WEB2API_KEY="wb2_replace_with_popup_value"

curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Reply with exactly WEB2API_OK"}'
```

验收标准：HTTP 200，最终文本为 `WEB2API_OK`。

把模型改为 `gemini/default` 再请求一次：

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini/default","input":"Reply with exactly WEB2API_GEMINI_OK"}'
```

验收标准：HTTP 200，最终文本为 `WEB2API_GEMINI_OK`。

把模型改为 `grok/default` 再请求一次：

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"grok/default","input":"Reply with exactly WEB2API_GROK_OK"}'
```

验收标准：HTTP 200，最终文本为 `WEB2API_GROK_OK`。通过模型接口确认三个 Provider 的默认模型和当前账号可见的动态模型：

```sh
curl http://127.0.0.1:3210/v1/models \
  -H "Authorization: Bearer $WEB2API_KEY"
```

模型 ID 必须带 `chatgpt/`、`gemini/` 或 `grok/` 前缀。动态模型只能进入对应 Provider worker。

## 5. 验证函数调用

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gemini/default",
    "input":"查询巴黎天气",
    "tools":[{
      "type":"function",
      "name":"get_weather",
      "description":"查询城市天气",
      "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false},
      "strict":true
    }]
  }'
```

验收标准：HTTP 200，`output[0].type` 为 `function_call`，`name` 为 `get_weather`，`arguments` 是包含 `city` 的 JSON 字符串。客户端执行函数后，必须携带 `previous_response_id` 和 `function_call_output` 续接同一 Provider 会话。该能力使用提示词模拟，不等价于 OpenAI 原生 strict function calling。

## 6. 自动化检查

```sh
pnpm test
pnpm typecheck
pnpm test:e2e:extension
pnpm test:e2e:extension-daemon
pnpm test:e2e:extension-responses
```

前三项验证单元、类型和扩展加载。后两项使用 fixture 页面串联真实扩展、daemon 和 Responses API，不要求 Provider 登录。

真实 ChatGPT 页面首次验收先建立专用登录 Profile：

```sh
pnpm test:smoke:chatgpt:setup
```

在弹出的 Chromium 中登录一次。命令检测到聊天输入框和图片上传控件后自动退出，登录态保存在 `~/.web2api/chatgpt-profile`。此后运行：

```sh
pnpm test:smoke:chatgpt
```

smoke test 不等待人工登录；Profile 未登录时立即失败并提示重新执行 setup。

真实 Gemini 验收使用系统 Google Chrome 和独立 Profile：

```sh
pnpm test:smoke:gemini:setup
```

在打开的 Gemini 页面登录，确认出现账号头像后关闭专用 Chrome。登录态保存在 `~/.web2api/gemini-profile`。随后运行：

```sh
pnpm test:smoke:gemini
```

Gemini smoke 必须通过本地 `/v1/responses` 直接验证文本、SSE 流式、多轮续接、动态模型切换、图片输入、图片生成和函数调用。测试日志与产物不得包含 Cookie、token、完整 prompt 或图片原始内容。

Chrome 151 及以上版本先通过 CDP 卸载同路径的旧扩展实例，再通过 `Extensions.loadUnpacked` 加载当前构建。图片生成必须使用动态发现的非 Lite Flash 模型；工具不可用或生成失败时 smoke 直接失败，不允许跳过。

真实 Grok 验收同样使用系统 Google Chrome 和独立 Profile：

```sh
pnpm test:smoke:grok:setup
```

在打开的 Grok 页面登录，确认页面不再显示登录按钮后关闭专用 Chrome。登录态保存在 `~/.web2api/grok-profile`。随后运行：

```sh
pnpm test:smoke:grok
```

Grok smoke 必须通过本地 `/v1/responses` 真实验证动态模型和推理模式发现、文本、SSE 流式、多轮续接、图片输入、函数调用，以及位于 `Imagine` 入口下的图片生成。扩展必须通过 CDP `Extensions.loadUnpacked` 加载。任何能力失败都直接失败，不允许跳过。

如果真实账号在 Imagine 页面显示额度或升级限制，图片生成验收会按真实结果失败；这不是登录态问题，需要等待额度恢复或使用有 Imagine 权限的账号重跑。

## 7. 卸载本地 Companion

```sh
node bin/glidea-web2api.mjs uninstall --extension-id <extension-id>
```

它会删除 Native Messaging 注册、复制的运行时和启动脚本。配置与 API key 保留在 `~/.web2api/config.json`。
