# 真实云端表格验收

[English](README.md) | 中文

这项可选浏览器验收运行正式 Antfarm Web profile、真实 Vultr DeepSeek 推理和独立 Workspace VM，按 issue #26 的云迁移方案覆盖 issue #12 的表格处理流程。

## 前提

构建当前检出及其独立 SSH helper。通过 `DSH_VULTR_TEST_CONFIG` 提供私有 Vultr 部署 JSON，通过 `DSH_VULTR_INFERENCE_KEY_FILE` 提供私有推理密钥文件。推理密钥必须有权为所选模型调用 `chat/completions`，成功查询模型目录不足以证明该权限。部署 JSON 遵循 [Vultr 指南](../../../../../docs/user/guide/workspace-vultr.zh.md)，SSH 密钥和 helper 必须在整个运行期间可用。仓库的 Playwright 依赖需要已安装 Chromium。

验收最多创建两台付费 VM 及对应快照，使用临时账号、私有数据目录和唯一部署标识，结束时只删除该部署的云资源。共享预览和既有账号不参与验收。

## 运行

```sh
DSH_VULTR_TEST_CONFIG=/private/deployment.json \
DSH_VULTR_INFERENCE_KEY_FILE=/private/inference.key \
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-spreadsheet.e2e.ts
```

缺少任一输入时，该文件跳过运行；跳过不构成验收证据。快照创建和恢复可能持续数分钟，验收允许两小时，不自动重试付费操作。

## 输入与断言

仅将 `sales.csv` 以 `销售明细.csv` 上传。样本包含已完成销售、负数量退货和取消订单。模型通过真实输入框接收汇总规则，用 Bash 生成 `月度汇总.csv`。月份使用 `YYYY-MM` 格式，按 CSV 单元格比较结果，兼容标准的引号和换行写法。独立指定的 `monthly.expected.csv` 保留在所有模型 Workspace 之外。三个自然月的金额分别为 348.40、976.40 和 394.70，年度合计 1,719.50，共计九条纳入记录、十六件净销量。

浏览器下载并核对月度结果，新建第二个 Session 继续处理同一文件，检查第二个 Workspace 的隔离，确认命令超时与后续进程清理，再尝试开启第三个 Workspace 观察容量满提示。随后关闭并恢复第一个 Workspace，比对原始文件与下载字节，并让真实模型在恢复后继续处理。

验收将空闲阈值设为十分钟、扫描间隔设为一秒。第二个 Workspace 完成任务后不再接受执行或文件活动，同时保存并恢复第一个 Workspace。浏览器随后核对第二个 Workspace 已自动关闭，文件仍可下载。这项时间覆盖验证配置后的策略，不代表测量默认三十分钟间隔。验收启用正式浏览器目录选择器 overlay。

## 证据

每次运行将截图、页面无障碍快照、原始浏览器录像、下载产物、步骤、最终结果和 Session 日志写入已忽略的 `.playwright-mcp/issue12-*` 目录，并输出其准确位置。只有测试进程以零状态退出、`result.json` 中 `success: true` 且云资源清理已确认，才表示验收完整完成。失败运行仅用于诊断，不能拼接成成功录像。

没有浏览器控制连接器时，使用隔离的无头 Playwright 上下文。共用启动器通过普通 Node 启动构建后的 Web profile。在模型请求之前，通过已鉴权的正式 API 配置个人推理凭据。模型和云端传输均为真实服务。原始录像保存为 WebM；编码 GIF 还需要仓库录制 skill 指定的媒体工具。
