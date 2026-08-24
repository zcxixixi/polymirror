# PolyMirror — 产品边界 / Product Scope

> **权威文档。** 产品定位与非目标以本文为准；其他文档若冲突，以本文为准。  
> Canonical. If other docs conflict, this file wins.

---

## 一句话

**PolyMirror 是自托管跟单软件，不是多租户 SaaS。**  
每位用户在自己的电脑或私有服务器上运行自己的实例；项目不提供托管私钥、不代运维、不运营共享云端跟单服务。

**PolyMirror is self-hosted software for personal / single-operator use — not a multi-tenant SaaS.**  
You run your own instance on your machine or private VPS. We do not host private keys, operate shared copy-trading cloud, or provide multi-tenant accounts.

---

## 部署模型（唯一支持）

```
你（运营商）
  └── 你的本机 / 私有 VPS / Docker
        └── 一个 PolyMirror 进程 + 本地 SQLite + 可选 Dashboard
              └── 私钥仅在该机 .env
```

| 项 | 说明 |
|----|------|
| 谁运维 | **你自己** |
| 谁持有私钥 | **你自己**（本地 `.env`） |
| 实例隔离 | 一人一实例；互不共享进程与数据库 |
| Dashboard | 同机控制台，不是公有云控制面 |

---

## 是 / 不是

| 是 | 不是 |
|----|------|
| 开源、自托管 daemon | 多租户云平台 |
| 单运营商自用（个人或小团队共用**同一实例**） | 给互不信任用户开账号的 SaaS |
| 配置里的「多账户」= **你自己的多个钱包** | 多租户用户体系、计费、云端注册登录 |
| Preview → Live 跟单执行 | 托管钱包 / 代签 / 代持仓 |
| 自建 VPS + 可选反代 TLS | 官方运营的托管跟单服务 |

### 「多账户」≠「多租户」

- **多账户（支持）：** 同一运营商在同一实例里管理多个自有钱包（`accounts[]`），Leader 与数据按账户隔离。
- **多租户 SaaS（不做）：** 平台侧为大量陌生用户提供隔离账号、云端策略下发、代签执行。

---

## 明确非目标（Non-goals）

下列能力 **不在产品路线图内**，文档与实现均不应暗示将要提供：

1. **多租户 SaaS** — 云端注册、租户隔离、订阅计费、共享控制面  
2. **托管私钥 / 代签** — 云端保存或使用用户 `POLYMARKET_PRIVATE_KEY`  
3. **代运维用户引擎** — 平台替用户跑跟单 worker  
4. **公有云「Web + Agent」控制面** — 曾规划的网站化方案已 **归档，不做**（见下）  
5. **作为投资顾问或收益承诺产品** — 软件工具，不保证盈亏  

---

## 归档：Web + Agent

[本地 `docs/WEB_AGENT_ARCHITECTURE.md`](../docs/WEB_AGENT_ARCHITECTURE.md)（仅本机、不进 GitHub）描述过「云端 UI + 本机 Agent」设想。

| 状态 | 说明 |
|------|------|
| **归档 / 非路线图** | 不实施、不承诺、不作为当前架构一部分 |
| 当前唯一路径 | 方案 B：自托管单机引擎（v1.0） |

任何提及「未来云控制面 / polymirror.com 托管策略」的表述，均以本文为准视为 **过时**。

---

## 对外沟通固定句

**中文：**

> PolyMirror 是跑在你自己机器上的 Polymarket 跟单引擎，不是多租户 SaaS。私钥自托管，自行部署与运维。

**English：**

> PolyMirror is a self-hosted Polymarket copy-trading engine—not a multi-tenant SaaS. You keep the keys and run your own instance.

---

## 相关文档

| 文档 | 关系 |
|------|------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 单机模块与数据流 |
| [SECURITY.md](SECURITY.md) | 自托管威胁模型 |
| [ECOSYSTEM_WORKFLOW.md](ECOSYSTEM_WORKFLOW.md) | 与研究/盯盘工具的分工 |
| 本地 `docs/WEB_AGENT_ARCHITECTURE.md`（不进 GitHub） | **归档**历史设想 |
