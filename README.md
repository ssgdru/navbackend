# README — Cloudflare Workers 一键部署手册

技术人员redhe1314的网址导航 — Workers 版。**功能、页面、样式与 FastAPI/1Panel 版完全一致**（不含 PCL2 下载功能）：多分类导航、PC/移动双布局、背景壁纸、各站点原生图标（代理+缓存）、免责声明页。

> 架构差异说明：FastAPI 版是"服务器常驻 + Nginx 反代"；Workers 版是"代码跑在 Cloudflare 边缘 + 静态资产/壁纸由 Cloudflare 资产层直出"。没有服务器、无需 SSH、无需配 Nginx、无需数据库。

---

## 一、包内容清单

```
cloudflare workers/
├── wrangler.toml           # Workers 配置（资产绑定/限流/变量，注释齐全）
├── package.json            # npm 元数据（仅依赖 wrangler CLI）
├── config.json             # ★ 导航数据（12 分类全部链接，与 FastAPI 版同一格式）
├── src/
│   ├── worker.js           # ★ 后端主程序（全部路由与安全逻辑）
│   ├── jinja.js            # 迷你 Jinja2 渲染器（输出与 FastAPI 版逐字节一致，已验证）
│   ├── md5.js              # MD5 实现（签名规则与 FastAPI 版完全兼容）
│   └── templates/
│       └── index.html      # 首页模板（与 FastAPI 版模板同一文件，原样保留）
├── public/                 # Cloudflare 静态资产（边缘直出，不计费请求）
│   ├── disclaimer.html     #   /disclaimer 直出
│   └── static/
│       ├── bg.jpg          #   /static/bg.jpg 壁纸
│       ├── favicon.png     #   /static/favicon.png
│       └── hdd-icon.png    #   备用图标
└── tests/
    └── test_render.py      # 本地验证脚本（渲染与真实 Jinja2 逐字节对比、MD5 向量）
```

> 本版本**不包含 PCL2 下载功能**（无 R2 桶、无下载路由）。该功能仅存在于 FastAPI/1Panel 版。

---

## 二、前置条件

1. Cloudflare 账号（免费版即可：每天 10 万次请求额度，个人导航站绰绰有余）
2. 本机安装 **Node.js 18 或更新版本**（含 npm）
3. 域名（可选）：要绑定 `hegemc.online` 这类自定义域名，域名需托管在 Cloudflare

> 开发与部署都在本机完成（wrangler CLI 直连 Cloudflare API），服务器不需要存在。

---

## 三、一键部署（共 4 条命令）

```bash
# 1. 进入解压后的目录
cd "cloudflare workers"

# 2. 安装依赖（只装 wrangler CLI）
npm install

# 3. 登录 Cloudflare（会弹出浏览器授权）
npx wrangler login

# 4. 一键部署
npx wrangler deploy
```

部署成功后会输出形如 `https://nav-backend.<你的子域>.workers.dev` 的访问地址，打开即是完整的导航站。

## 四、绑定自定义域名（可选）

1. 确认域名托管在 Cloudflare（DNS 由 CF 管理）
2. Cloudflare 控制台 → **Workers 和 Pages** → `nav-backend` → **设置 → 域和路由** → **添加自定义域** → 填 `hegemc.online`
3. 证书由 Cloudflare 自动签发（无需手工申请，HTTP 自动跳 HTTPS）
4. 也可以用 `wrangler.toml` 声明（部署时自动绑定）：

```toml
routes = [
  { pattern = "hegemc.online", custom_domain = true }
]
```

---

## 五、日常修改

| 要改什么 | 怎么改 | 生效方式 |
|----------|--------|----------|
| 导航分类/链接/名称 | 编辑根目录 `config.json` | `npx wrangler deploy` 重新部署 |
| 新增 fav 图标站点 | config.json 中 `icon: "fav"` 即可，域名自动进白名单 | 重新部署 |
| 页面样式/布局 | 编辑 `src/templates/index.html`（Jinja2 语法） | 重新部署 |
| 免责声明 | 编辑 `public/disclaimer.html` | 重新部署 |
| 签名密钥 | `wrangler.toml` 的 `[vars] API_SECRET` | 重新部署 |
| 本地预览 | `npx wrangler dev` | 浏览器开 http://localhost:8787 |

**config.json 语法规则与 FastAPI 版完全相同**：相邻条目之间英文逗号、最后一项不加逗号、禁止中文标点；改完先 `python -m json.tool config.json` 自检再部署——JSON 坏了会导致整站 500（这是 FastAPI 版真实发生过的故障，Workers 版同样会在启动时崩溃）。

---

## 六、与 FastAPI/1Panel 版的功能对照

| 功能 | FastAPI 版 | Workers 版 | 说明 |
|------|-----------|-----------|------|
| 多分类导航 / PC+移动双布局 | ✅ | ✅ | 同一模板，渲染输出逐字节一致（tests/test_render.py 已验证） |
| 背景壁纸 | Nginx 直出 | CF 资产直出 | 两者都带边缘缓存 |
| 站点 favicon.ico | main.py 路由 | Worker 路由 → 资产 | 行为一致 |
| 免责声明页 | Jinja2 渲染 | 资产直出 | 内容一致 |
| 站点图标代理 /icon/ | 内存白名单 + 磁盘缓存 + 1h 负缓存 | 白名单 + **Cache API 边缘缓存** + 1h 负缓存（404 缓存） | 失败回退圆点行为一致 |
| IP 限流 | 进程内存计数器（60/min） | 由 **CF 控制台 WAF 速率规则**承担（Worker 内实验性 binding 已移除） |
| 安全响应头 CSP 等 | 中间件统一注入 | Worker 统一注入 | 头集合一致 |
| `/api/nav` 60 秒签名 | ✅ | ✅ | 同 secret 同算法，手工 URL 命令通用 |
| **PCL2 下载** | ✅（签名 24h） | ❌ **未移植** | 需要该功能请使用 FastAPI/1Panel 版 |
| 资产防盗链（bg.jpg Referer） | main.py 内置 | **无**（资产层直出不经过 Worker） | 可在 CF 控制台 WAF 加 Referer 规则 |

---

## 七、验证清单

```bash
# 部署完成后（把域名换成你的 workers.dev 地址或自定义域）
curl -s -o /dev/null -w "home: %{http_code}\n" https://hegemc.online/                       # 200
curl -s -o /dev/null -w "wallpaper: %{http_code}, %{size_download}\n" https://hegemc.online/static/bg.jpg   # 200, 863940
curl -s -o /dev/null -w "favicon: %{http_code}\n" https://hegemc.online/favicon.ico         # 200
curl -s -o /dev/null -w "icon: %{http_code}\n" https://hegemc.online/icon/www.baidu.com     # 200
curl -s -o /dev/null -w "api-no-sign: %{http_code}\n" https://hegemc.online/api/nav         # 422（签名防护生效）
curl -s https://hegemc.online/health                                                        # {"status":"ok",...}
```

浏览器打开首页：分类、图标、壁纸全部与 FastAPI 版一致。

### 本地预检（不部署也能跑）

```bash
py tests\test_render.py    # 依赖 jinja2 + dukpy（pip install jinja2 dukpy）
```

校验内容：mini-Jinja 渲染输出与真实 Jinja2 **逐字节一致**；MD5 实现与 FastAPI 版签名向量一致（含生产环境实测向量）；图标白名单 55 个唯一域名；页面输出中不含任何 PCL2 残留。

---

## 八、故障排查

| 症状 | 根因 | 处理 |
|------|------|------|
| 403 `Invalid signature` | 链接超期 / secret 改过 / 时间不同步 | 核对 API_SECRET；确认服务器与本机时间 |
| 422 field required | 裸访问 `/api/nav` 带签名路由 | 正常防护行为 |
| 整站 500 | config.json 语法错误（改完没自检） | `python -m json.tool config.json` |
| 图标全为圆点 | 目标站无标准 favicon 或出网被限 | 1 小时后自动重试（负缓存过期）；重新 deploy 清缓存 |
| 首页能开但样式乱 | public/static 未随包上传 | 确认 `public/static/bg.jpg` 存在后重新 deploy |
| workers.dev 打不开 | 某些地区网络限制 | 绑定自定义域名（第四节） |
| 429 Too Many Requests | WAF 速率规则触发（如已配置） | 正常防护；需要更高额度在 CF 控制台调整 |

---

## 九、安全说明与边界

- ts+MD5 签名为门槛型防护：`API_SECRET` 位于 `wrangler.toml [vars]`（部署后可在控制台改为加密 Secret：`npx wrangler secret put API_SECRET` 并从 vars 移除），抓包可见全部参数与返回数据；60 秒窗口内签名可重放
- 图标代理有域名白名单 + 256KB 上限 + 4 秒超时，防开放代理滥用；第三方 favicon 缓存在 Cloudflare 边缘（访客 IP 不会暴露给第三方站点，与 FastAPI 版一致）
- 资产层（/static/、/disclaimer）由 CF 直出，不经过 Worker 安全头；如需对这些路径加安全头/防盗链，用 CF 控制台的 **Transform Rules / WAF** 配置
- 实验性 Rate Limit binding 已移除（CF API 拒绝其 namespace_id 格式，导致 CI 部署失败）；限流改由 **CF 控制台 → 安全性 → WAF → 速率限制规则** 承担（Worker 代码自动兼容，无 binding 时跳过限流）
- 无服务器架构下没有可被攻破的"主机"，攻击面集中在 Worker 代码与 CF 平台配置本身

---

## 十、成本与限额（免费额度）

| 项 | 免费额度 | 本项目用量 |
|----|----------|-----------|
| Workers 请求 | 10 万次/天 | 个人导航页访问量级 |
| 静态资产 | 免费、不限请求 | 壁纸/图标/声明页 |
| Cache API | 免费 | 图标缓存 |
| 自定义域名 | 免费 | 证书自动签发 |
