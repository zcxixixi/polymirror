# 03 — 启动与自检

## 目标

启动 Preview 引擎，打开 Dashboard，确认 `/health` 为 ok。

## 你需要准备

- 已完成 [02 — 首次配置](02-first-config.md)
- 浏览器（Chrome / Firefox / Edge / Safari 均可）
- 若在中国大陆：本机代理已开启（与上一章一致）

## 步骤

### 1. 启动引擎（推荐：一条命令）

在仓库根目录：

```bash
npm run build:dashboard
npm run dev
```

- `build:dashboard`：首次或前端有改动时执行一次  
- `npm run dev`：启动引擎；Dashboard 与 `/health` 同端口（默认 **8080**）

终端应持续运行，不要关掉。看到无致命报错、开始轮询即可。

### 2. 打开 Dashboard

浏览器访问：

```
http://127.0.0.1:8080/
```

若你改过 `config.yaml` 里的 `health_port`（例如 `8081`），请改用：

```
http://127.0.0.1:8081/
```

本机默认**无需登录**（未设置 `DASHBOARD_TOKEN` 时）。不要把该端口暴露到公网。

### 3. 检查健康接口

另开一个终端，或浏览器直接打开：

```bash
curl -s http://127.0.0.1:8080/health
```

（端口与 `health_port` 保持一致。）

期望 JSON 中含有：`"status": "ok"`（字段名以实际输出为准）。

### 4. Dashboard 里快速看一眼

| 页面 | 期望 |
|------|------|
| 总览 | 能加载；模式为 **Preview** |
| Leader | 至少一个启用 |
| 发现 / 外网相关页 | 能加载数据；否则多半是代理未通 |

### 5.（可选）前后端分离开发

改前端时可用两个终端：

```bash
# 终端 1
npm run dev

# 终端 2 — 默认代理到 8080
npm run dev:dashboard
```

然后打开 Vite 提示的地址（通常 `http://127.0.0.1:5173`）。

若 `health_port` **不是** `8080`：

```bash
VITE_API_PORT=8081 npm run dev:dashboard
```

把 `8081` 换成你的实际端口。

## 如何确认成功 + 常见失败

**本入门路径的成功标准（请全部勾上）：**

- [ ] `npm run dev` 在跑，无持续崩溃
- [ ] 浏览器能打开 Dashboard
- [ ] `/health` 返回 ok
- [ ] 至少一个 Leader 为启用状态

| 现象 | 怎么办 |
|------|--------|
| 浏览器打不开页面 | 确认进程在跑；端口是否与 `health_port` 一致；是否被防火墙拦截 |
| Dashboard 空白 / API 失败 | 开发模式检查 `VITE_API_PORT`；或改用 `build:dashboard` + 同端口访问 |
| 启动即退出 / 配置校验失败 | 检查 `.env` 私钥与地址；确认复制了 Preview 模板 |
| Discover 加载失败 | 配置 `HTTPS_PROXY` 或 `global.proxy`，并确认本机代理软件在监听 |
| 一直没有 `PREVIEW would copy` | 正常：要等 Leader **有新成交**且通过过滤；先保证 health/Leader 正确即可 |

**下一章 →** [04 — 添加 Leader](04-add-leader.md)  
**一页勾选 →** [CHECKLIST.md](CHECKLIST.md)  
**进阶阅读 →** [dashboard/02-getting-started.md](../../dashboard/02-getting-started.md)（短版）· [RUNBOOK.md](../../RUNBOOK.md)
