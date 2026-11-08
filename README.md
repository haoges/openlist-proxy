# OpenList Proxy

增强版 OpenList 下载代理，支持 **Cloudflare Workers** 和 **EdgeOne Makers Edge Functions**。基于 [OpenListTeam/OpenList-Proxy](https://github.com/OpenListTeam/OpenList-Proxy) 的 Worker 实现改进。

## 功能

- 兼容 Cloudflare Workers 标准 `fetch(request, env)` 入口。
- 兼容 EdgeOne Makers `onRequest(context)` 入口。
- 保留 OpenList 下载签名校验（HMAC-SHA256）。
- GET / HEAD / OPTIONS、CORS 预检及可选来源白名单。
- Range / If-Range 等断点续传请求头转发。
- 下载响应采用 Web Streams 流式转发，不主动缓存整个文件。
- 上游 API / 下载源超时、异常处理和重定向次数限制。
- 不转发客户端 Cookie / Authorization，跨域重定向时清理敏感请求头。
- `/health` 健康检查端点。

> 注意：本项目用于代理 OpenList 下载流量。请遵守所使用边缘平台的服务条款、流量限制和适用法律。Cloudflare 官方 OpenList 文档提示，不应将 Workers 代理作为长期、大流量生产用途。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---:|---|---|
| `ADDRESS` | 是 | - | OpenList 地址，例如 `https://list.example.com`，不要以 `/` 结尾 |
| `TOKEN` | 是 | - | OpenList 管理后台「其他设置」中的 API Token，必须设置为 Secret |
| `WORKER_ADDRESS` | 否 | 当前请求域名 | 代理对外访问地址，用于识别回源到代理自身的重定向 |
| `DISABLE_SIGN` | 否 | `false` | 设置为 `true` 将关闭签名验证，不推荐 |
| `CORS_ORIGINS` | 否 | `*` | 允许的 Origin，多个域名用英文逗号分隔；生产环境建议明确指定 |
| `REQUEST_TIMEOUT_MS` | 否 | `30000` | 单次上游请求超时，最大 120000 毫秒 |
| `MAX_REDIRECTS` | 否 | `8` | 最大重定向次数，范围 0–15 |

地址不要添加尾部斜杠。不要把 TOKEN 写入仓库或公开配置文件。

## Cloudflare Workers 部署

1. 将仓库导入 Cloudflare Workers，入口文件选择根目录 `openlist-proxy.js`（仓库已提供 `wrangler.toml`）。
2. 在 Worker Settings → Variables and Secrets 添加变量：
   - `ADDRESS`：OpenList 服务地址。
   - `TOKEN`：使用 Secret 类型。
   - 可选设置 `WORKER_ADDRESS`、`CORS_ORIGINS` 等。
3. 也可以使用 Wrangler：

```bash
npx wrangler secret put TOKEN
npx wrangler deploy
```

`ADDRESS` 等非敏感变量可在 Dashboard 配置，或写入本地未提交的 Wrangler 环境配置。

## EdgeOne Makers 部署

本仓库已提供 Edge Functions 路由适配器：

```
edge-functions/
└── [[default]].js
openlist-proxy.js
```

1. 在 EdgeOne Makers 中导入 `haoges/openlist-proxy` 仓库。
2. 确认项目启用了 Edge Functions，保留仓库中的 `edge-functions/[[default]].js` 路由文件。
3. 在 Makers 项目环境变量中添加 `ADDRESS` 和 `TOKEN`，其中 `TOKEN` 使用平台提供的加密/Secret 配置能力。
4. 部署后访问 `https://你的域名/health`，看到 `OpenList Proxy is running` 即表示函数入口正常。

EdgeOne Makers 使用 `context.request`、`context.env`，适配器再调用共用的 Worker 处理器；核心代码只依赖标准 Web API，不依赖 Cloudflare 专有绑定。

## OpenList 配置

在 OpenList 管理后台的下载代理配置中填写 Worker / EdgeOne Makers 的部署地址，不要在末尾添加 `/`。签名验证保持开启。OpenList 生成的下载链接会携带签名参数，代理会使用 `TOKEN` 校验。

## 测试

```bash
curl -i https://你的代理域名/health
```

健康检查不验证 OpenList 连通性，仅用于确认函数已部署。实际下载请通过 OpenList 前端生成下载链接测试，并分别测试大文件、Range 断点续传、HEAD 请求和跨域访问。

## 说明与限制

- `DISABLE_SIGN=true` 会使任何知道文件路径的人都可能请求下载，请谨慎使用。
- CORS 白名单不是身份认证机制；下载签名仍应保持开启。
- 超时限制覆盖上游请求建立阶段；流式响应后续传输时间仍受边缘平台自身限制。
- 某些存储驱动要求特定请求头，代理会合并 OpenList 返回的 `data.header` 与必要的客户端下载头。
- 平台可能对执行时间、单次 fetch 数量、文件大小和流量另有限制。

## License

GNU General Public License v3.0。此项目基于 OpenListTeam/OpenList-Proxy 的 GPL-3.0 项目修改，详见 [LICENSE](./LICENSE)。
