# Web2API 验收步骤手册

本手册把确定性自动化验收和真实 ChatGPT 网页 Smoke Test 分开。fixture 测试通过，不代表当前 ChatGPT 生产页面一定兼容。

## 1. 前置条件

- Node.js 22 或更高版本
- pnpm 10
- 支持扩展开发者模式的 Chromium 浏览器
- ChatGPT 测试账号
- 本机 `3210` 端口可用

```sh
node --version
pnpm --version
```

## 2. 自动化验收

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm test:e2e:extension
pnpm test:e2e:extension-daemon
pnpm test:e2e:extension-responses
```

验收标准：

- Vitest 全部通过
- TypeScript 无类型错误
- MV3 Service Worker 正常启动
- popup 可以打开
- Content Script 只注入 ChatGPT 页面
- 两个扩展 worker 成功连接 daemon
- 本地 Responses 请求可以经过真实扩展到达 fixture 页面
- 新会话和续接会话使用正确的 worker URL

## 3. 构建交付物

```sh
pnpm pack:extension
pnpm pack --pack-destination /tmp/web2api-pack-check
```

扩展产物必须存在：

```text
dist/web2api-extension.zip
```

npm tarball 必须包含 daemon CLI、daemon 源码和 shared protocol，不应包含测试文件或扩展开发产物。

## 4. npm 包验收

在源码目录外执行：

```sh
TEST_DIRECTORY="$(mktemp -d)"
cd "$TEST_DIRECTORY"
npm init -y
npm install /absolute/path/to/web2api/web2api-0.1.0.tgz
npx web2api start
```

终端应打印：

```text
Web2API listening on http://127.0.0.1:3210
API key: wb2_...
Config: ...
Extension: disconnected
```

## 5. 加载扩展并启动 daemon

构建未打包扩展：

```sh
pnpm build:extension
```

在 Chromium 中：

1. 打开 `chrome://extensions`
2. 开启 Developer mode
3. 点击 Load unpacked
4. 选择 `src/extension/.output/chrome-mv3`
5. 打开 Web2API popup

随后启动 daemon：

```sh
npx tsx src/daemon/cli.ts start
```

记录终端打印的 API key，不要提交或分享。默认配置位于 `~/.web2api/config.json`，文件权限为用户私有。

检查健康状态：

```sh
curl http://127.0.0.1:3210/healthz
```

当扩展已连接并创建两个 worker 时，关键字段应为：

```json
{
  "status": "ok",
  "daemon": "ready",
  "extension_connected": true,
  "workers_ready": 2
}
```

如果 worker 页面要求登录，在专用 worker 页面中手动登录 ChatGPT。

## 6. `/v1/models`

```sh
export WEB2API_KEY="wb2_replace_with_real_key"
curl http://127.0.0.1:3210/v1/models \
  -H "Authorization: Bearer $WEB2API_KEY"
```

验收标准：

- 必须包含 `chatgpt/default`
- 其他模型必须来自当前账号页面实际可见的模型选项
- 不得返回固定维护但当前账号不可用的模型

## 7. 非流式文本

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Reply with exactly WEB2API_TEXT_OK"}'
```

验收标准：

- HTTP 状态码为 `200`
- `object` 为 `response`
- `status` 为 `completed`
- `id` 以 `resp_` 开头
- 输出文本非空
- ChatGPT 页面只新增一条用户消息

## 8. 多轮续接

复制上一条响应的 `id`：

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Reply with exactly WEB2API_CONTINUED_OK","previous_response_id":"resp_replace_with_previous_id"}'
```

验收标准：

- 请求进入同一个 ChatGPT conversation
- 返回的 response ID 仍绑定同一 conversation
- 页面没有重复提交上一条 prompt

## 9. 流式与取消

```sh
curl --no-buffer http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Write four short numbered lines","stream":true}'
```

验收标准：

- Content-Type 为 `text/event-stream`
- 事件从 `response.created` 开始，以 `response.completed` 结束
- 中间收到多个 `response.output_text.delta`
- 拼接所有 delta 等于最终文本

取消验证：启动长文本请求，中途中断 `curl`，确认 ChatGPT 页面停止生成且 worker 恢复 ready。

## 10. 并发标签页

在 `~/.web2api/config.json` 设置 `max_tabs` 为 `2`，重启 daemon。

1. 启动会话 A 的请求 A1
2. A1 未完成时启动另一个会话 B 的请求 B1
3. A1 未完成时继续会话 A，发送 A2

验收标准：

- A1 和 B1 可以使用不同 worker 并行执行
- A2 必须等待 A1
- 一个 worker 不能同时执行两个任务
- 关闭 busy worker 后当前请求失败，不得在其他 worker 自动重放

## 11. 模型和思考等级

只使用 `/v1/models` 或当前 ChatGPT 页面实际可见的选项。

验收标准：

- `chatgpt/default` 不触发模型切换
- 可用模型在提交 prompt 前完成切换
- 不可用模型返回 `400 model_not_available`，且页面不新增消息
- 不可用 effort 返回 `400 reasoning_effort_not_available`，且页面不新增消息

部分账号没有额外模型或 reasoning 控件。此时应记录为账号能力不可用，不得伪造通过结果。

## 12. 图片输入、编辑和生图

准备一个小 PNG 并转成 data URL：

```sh
IMAGE_BASE64="$(base64 < /absolute/path/to/input.png | tr -d '\n')"
```

图片编辑：

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"chatgpt/default\",\"input\":[{\"type\":\"input_text\",\"text\":\"Create a monochrome version\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,$IMAGE_BASE64\"}],\"tools\":[{\"type\":\"image_generation\"}]}"
```

文本生图：

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Generate a simple black square on a white background","tools":[{"type":"image_generation"}]}'
```

验收标准：

- 页面中的图片顺序与请求一致
- 响应包含 `image_generation_call.result`
- 返回的 base64 可以解码为非空图片字节
- 无效或超限图片在提交 prompt 前失败

## 13. 认证和失败场景

无效 API key：

```sh
curl -i http://127.0.0.1:3210/v1/models \
  -H "Authorization: Bearer invalid"
```

应返回 `401`。

登出专用 ChatGPT worker profile 后发送合法请求，应满足：

- HTTP 状态码为 `503`
- 错误码为 `chatgpt_login_required`
- 页面没有提交 prompt

## 14. 真实网页 Smoke Test

```sh
pnpm test:smoke:chatgpt
```

命令会打开专用 Chromium profile：`~/.web2api/chatgpt-profile`。首次运行由测试人员在该窗口手动登录 ChatGPT。禁止读取或复制其他浏览器的 Cookie、localStorage 或 profile。

当前 Smoke 自动覆盖：扩展加载、登录检测、一条文本请求和 conversation continuation。模型、reasoning、图片和并发仍需手工验收，直到对应自动化用例补齐。

## 15. 发布门禁

发布前必须确认：

- 单测、类型检查和三个扩展 E2E 全部通过
- 扩展 zip 和 npm tarball 可以生成
- daemon 日志不包含 prompt、response、图片和 ChatGPT 凭据
- 默认日志不泄露 API key
- 真实网页 Smoke 结果与 fixture E2E 结果分开记录
- 当前 ChatGPT 生产页面上的真实 Smoke 未通过时，不得宣称兼容
