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
- 自动打开两个 ChatGPT worker 标签页
- popup 展示 Base URL 和 API key
- 可以在 popup 启动、停止、重启 daemon
- 修改 Concurrent tabs 后保存会重启 daemon 并调整标签页数量

如果 ChatGPT worker 页面未登录，直接在其中登录。Web2API 不复制 Cookie。

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

## 5. 自动化检查

```sh
pnpm test
pnpm typecheck
pnpm test:e2e:extension
pnpm test:e2e:extension-daemon
pnpm test:e2e:extension-responses
```

前三项验证单元、类型和扩展加载。后两项使用 fixture 页面串联真实扩展、daemon 和 Responses API，不要求 ChatGPT 登录。

## 6. 卸载本地 Companion

```sh
node bin/glidea-web2api.mjs uninstall --extension-id <extension-id>
```

它会删除 Native Messaging 注册、复制的运行时和启动脚本。配置与 API key 保留在 `~/.web2api/config.json`。
