---
description: "通过独立 Linux Runner 启用经过鉴权的工作区沙箱管理。"
kind: "user-guide"
---

# 工作区沙箱管理

[English](workspace-sandboxes.md) | 中文

<a id="prepare-the-deployment"></a>
## 准备部署

使用可选的 [Web overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml)，前提是已按照 [Runner 部署说明](../../../team-docs/SANDBOX-RUNNER.md)部署独立 Runner。Docker 凭据及 socket 不能进入 Web 进程。Web 进程只需要 Runner 管理 socket 和持久工作区根目录。

将 `DSH_MULTIUSER_WORKSPACE_ROOT` 设置为 Runner 配置的同一 Linux 规范目录，将 `DSH_SANDBOX_RUNNER_SOCKET` 设置为管理 socket。根目录应位于 Docker 数据目录之外；容器化的 Harness 和 Runner 进程必须看到 Engine 挂载的同一绝对路径。原生工作区创建流程以 0700 权限分配目录：容器配置 UID 必须与非 root Harness 用户一致，Runner 需要遍历和挂载权限。启动前准备这些权限；开启沙箱不会更改所有者或复制旧工作区。

通过已有的[多用户维护命令](../../../packages/api/multiuser/README.zh.md#configuration)创建账号。验收使用独立测试存储根目录；维护命令不会覆盖已有账号。

```sh
export DSH_MULTIUSER_WORKSPACE_ROOT=/srv/agentrush/workspaces
export DSH_SANDBOX_RUNNER_SOCKET=/run/agentrush-sandbox/runner.sock
pnpm run start:web --patch apps/cli/config/examples/harness-sandbox.patch.yml --no-open
```

Antfarm 默认 Web 入口提供账号登录和工作区文件服务，overlay 增加沙箱管理。在执行隔离接入之前，默认入口保留原生对模型工具和终端交接的限制。它不会把有 Docker 权限的 Runner 加载进 Web。缺少必需配置时启动失败。直接使用 `pnpm dsh web` 时，需在此 overlay 之前加载 `apps/cli/config/antfarm-web.patch.yml`。

<a id="call-the-management-methods"></a>
## 调用管理方法

通过已有 `/auth/login` 流程登录，再通过原生工作区接口创建工作区。后端解析已保存的所有者和目录；浏览器输入不能选择宿主目录或容器。

| Typert 方法 | 业务参数 | 结果 |
| --- | --- | --- |
| `workspaceSandbox/open` | `request: { workspaceId }` | `{ workspaceId, state: 'running' }` |
| `workspaceSandbox/status` | `request: { workspaceId }` | `{ workspaceId, state }` |
| `workspaceSandbox/close` | `request: { workspaceId }` | `{ workspaceId, state: 'closed' }` |

Connection 使用普通 Typert 请求封装、登录 cookie 和 Host/Origin 检查，通过 POST `/api/<method>` 承载这些方法。跨用户和不存在的工作区访问在联系 Runner 前被拒绝。管理结果不含内部路径、容器编号或堆栈。

状态表示一次当前观察：`closed`、`starting`、`running`、`closing` 或 `cleanup_required`。查询失败是错误，不会猜测为 `closed`。容量、启动、关闭、清理、配置冲突和服务故障通过 `sandbox/failed` 下不同的稳定原因表示，见[包参考](../../../packages/sandbox/harness-sandbox/README.zh.md#use-this-package)。

修改出现 `outcomeUnknown: true` 时重新查询，以了解最终结果。Harness 不会自动重复 PUT/DELETE，也不会在开启结果不明时补偿关闭。关闭会结束该容器中的全部命令，仅在确认移除后成功；工作区文件、会话和登记保留，可供重新开启。

移除工作区登记前先关闭其沙箱。删除会查询 Runner 并要求 `closed`；正在开启或活跃的沙箱返回 `workspace/sandbox-active`，Runner 不可用时保留工作区。管理服务卸载或重载期间同样拒绝删除，服务恢复后可重试。目录移动或丢失后仍可查询和关闭，不会阻止清理。

<a id="continue-the-integrations"></a>
## 继续接入

自动开启和 Bash 转发属于 #7，空闲回收属于 #8，浏览器控件属于 #9。[接入交接](../../../packages/sandbox/harness-sandbox/README.zh.md#integration-handoff)说明正式授权内部方法和浏览器 API。overlay 提供后端管理，不增加模型工具或沙箱管理提示词。
