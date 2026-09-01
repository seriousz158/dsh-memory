# DSH 独立长期记忆库

本仓库只属于当前 DSH 实例，不与其他客户端的记忆目录共享。

## 目录

- `summary.md`：稳定偏好、当前项目指针和高置信导航；必须保持不超过 12 KiB，详细证据放入 `handbook/` 或 `rollouts/`。
- `handbook/`：可跨会话复用的项目或主题知识。
- `rollouts/`：单次会话的提炼结果，供后续整合。
- `archive/`：已过时或被替代的条目。
- `scripts/filter_session.py`：将 DSH 会话日志转为精简、脱敏的转录。
- `.last-sync`：增量同步水位；首次创建时不回溯旧会话。
- `.sync/usage.json`：本地读取使用计数与最近使用时间；只存元数据，不进 Git。

## 规则

1. 只记录已验证、跨会话有价值的结论；不要记录闲聊、长推理或大段原始输出。
2. 不写入 token、密码、API key、连接串或其他凭据；敏感值使用 `[REDACTED]`。
3. `summary.md` 是导航，`handbook/` 是知识，`rollouts/` 是原料；新证据应覆盖过时结论，而不是无止境追加。
4. 会话日志只读。删除记忆使用设置页的双重确认；Git 历史用于日常恢复，不等同于隐私意义上的彻底抹除。

## 同步权限与环境

`dsh-memory-sync` 默认运行已安装的 `dsh`，也可以用 `DSH_BIN` 指向另一个已安装的可执行文件。脚本不会自动下载或安装软件。默认权限模式是 `workspace-write`；如需更窄权限，可显式设置 `DSH_PERMISSION_MODE=read-only`。

同步子进程从空环境启动，只保留 `HOME`、`DSH_HOME`、`DSH_MEMORY_ROOT`、`PATH`、`TMPDIR`、`LANG`、已导出的 `LC_*` 和同步所需的 DSH 控制项。Provider 所需变量必须按空格分隔，将变量名显式列入 `DSH_MEMORY_PROVIDER_ENV_NAMES`；未列出的凭据和 MCP 变量不会继承。变量值不会由同步包装脚本写入提示词或日志。

## 隐私边界与恢复

过滤器会在截断前递归处理用户文本、助手文本、工具参数和工具结果，替换常见 bearer token、API key、GitHub/AWS 形状的凭据、密码或 token 查询参数，并把常见绝对 home 前缀规范为 `$HOME`。这是一层防御，不是任意秘密格式的完整检测器；不要主动把凭据发进会话。

原始会话日志仍保留在本地 DSH 会话目录中，过滤器不会改写或删除源日志。若敏感值已经进入记忆 Git 历史，普通回退或删除当前文件不能保证彻底抹除；停止同步、轮换相关凭据，并按本机数据保留策略处理源日志和仓库历史。

## 写入边界（单写者契约）

普通会话对本仓库**只读**：不要直接写任何记忆文件，不要执行任何 git 命令。唯一写入路径是周期性事务同步 `dsh-memory-sync`：模型只在宿主准备的隔离 staging 副本中修改 `summary.md`、`handbook/`、`rollouts/`、`archive/`，退出后由宿主校验、提交并推进水位；本仓库的 README、`.sync/.gitignore` 和 `scripts/filter_session.py` 是宿主管理的只读模板，模型与 staging 都不得修改。

会话中产生的记忆请求（建议沉淀的结论）记录在会话输出中即可，由后续同步负责落库。

## 元数据规范

新增或修改 handbook/ 与 rollouts/ 记录时必须携带 schema v1 front matter；列表字段（如 `tags`、`source_rollouts`）必须使用块列表，不允许行内流程写法：

```yaml
---
schema_version: 1
id: preference-response-language
type: preference
status: active
confidence: high
created_at: 2026-08-19
updated_at: 2026-08-19
tags:
  - dsh-memory
  - 检索
source_rollouts:
  - rollouts/2026-08-19-session-001.md
---
```

## 提炼与整合

提炼时只保留：稳定用户偏好、最终方案与原因、失败模式、项目入口、可复现命令和明确的后续契约。无高信号时写 `NO_SIGNAL` 并跳过。

溯源与显式冲突链（宿主 fail-closed 校验）：新增 `handbook/` 条目必须至少携带 `source_rollouts`、`source_session_digest`、`source_hash` 之一，否则宿主拒绝整个 staging diff（`missing-provenance`）。覆盖旧条目时不要静默改写：新条目声明 `supersedes: <旧条目 id>`，并把旧条目 `status` 置为 `superseded`（或移入 `archive/`）；确有无法合并的矛盾时用 `conflicts_with: <对方 id>` 显式标注，等待人工裁决。

整合时先比较新旧条目：冲突则覆盖、过时则移入 `archive/`、无变化则不制造噪声。`summary.md` 最终必须不超过 12 KiB；超出时压缩重复过程和细节，不得静默超出预算。不要执行 git、不要更新同步水位：宿主会在 staging 校验通过后代为提交。
