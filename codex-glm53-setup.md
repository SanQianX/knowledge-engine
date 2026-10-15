# Codex CLI 切换 GLM-5.3：当前状态与待解决问题

> 用途：把本机 Codex 的模型（含会话内所有派生任务/子代理）切到智谱 GLM-5.3。
> 本文自包含全部现场信息，可直接交给任何 agent / 他人继续处理。

## 一、目标

- 使用 Codex CLI（当前版本 `codex-cli 0.137.0`）时，让会话跑在 GLM-5.3 上（智谱 BigModel 国内站）。
- 默认 `codex` 会话保持现状不动（OpenAI / ChatGPT 账号登录，`gpt-6.1-sol`）；GLM-5.3 通过 profile 按需启用。
- 说明：「子代理」没有单独的模型配置项——Codex profile 是顶层 `model` 覆盖，profile 生效后该会话内主 agent 与任何派生任务（review 等）都走同一个模型。

## 二、本机已就绪的部分（无需重做）

### 1. `~/.codex/config.toml` 已有 ZAI provider 条目

```toml
# ---- GLM (智谱) provider:默认仍为 OpenAI + ChatGPT 账号登录;GLM 切换见 ~/.codex/glm.config.toml ----
[model_providers.ZAI]
name = "ZAI"
base_url = "https://open.bigmodel.cn/api/v1"
env_key = "ZAI_API_KEY"
wire_api = "responses"
```

### 2. `~/.codex/glm.config.toml` profile 文件已指向 glm-5.3

```toml
# GLM profile —— 用法: codex --profile glm(此文件由新 profile 机制加载,替代旧 [profiles.glm] 表)
# 模型目录只在 GLM 会话内生效,不影响默认 OpenAI 会话的模型列表
model_provider = "ZAI"
model = "glm-5.3"
model_reasoning_effort = "xhigh"
model_catalog_json = 'C:\Users\SanQian\.codex\models.json'
```

### 3. `~/.codex/models.json` 已含 glm-5.3 目录项

含 `default_reasoning_level: "xhigh"`、supported levels（low/high/xhigh）、`supported_in_api: true`。

## 三、已验证的事实

1. **profile 机制匹配**：Codex 0.137.0 的 `--profile`（帮助文本称 `CONFIG_PROFILE_V2`）会「Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config」，即 `codex --profile glm` 正好加载 `~/.codex/glm.config.toml`。文件命名与写法正确。
2. **端点真实存在**：`POST https://open.bigmodel.cn/api/v1/responses`（无效 token 探测返回 `{"code":401,"msg":"令牌已过期或验证不正确","success":false}`）——路由正确，只等有效 key。
3. **错误端点已排除**：`https://open.bigmodel.cn/api/codex/responses` 返回 404（NOT_FOUND），不要用这个路径。
4. **国际站端点仅供参考**：docs.z.ai 文档给的是 `https://api.z.ai/api/v1`（wire_api responses），本机用的是国内站 `open.bigmodel.cn`，两者同源不同站，key 不通用。

## 四、卡点（唯一缺失项）

**`ZAI_API_KEY` 环境变量未设置**——已查 User / Machine / 当前 shell 三处，均无 `ZAI_* / BIGMODEL_* / ZHIPU* / GLM*` 形式的 API key（已有的 `ZAI_OAUTH_*` 等变量是 ZCode 桌面端的 OAuth 配置，不是 API key，不能复用）。

provider 声明了 `env_key = "ZAI_API_KEY"`，Codex 启动 GLM 会话时会读这个环境变量；没有它会在鉴权处直接失败。

需要：从智谱开放平台控制台（bigmodel.cn，GLM Coding Plan / API keys 页面）取得 key，然后：

```powershell
setx ZAI_API_KEY "<你的key>"   # 写入用户级环境变量,之后重开终端生效
```

## 五、配好 key 之后的验证步骤

```bash
# 1. 确认环境变量已生效(新开终端)
echo $env:ZAI_API_KEY   # PowerShell;或 bash: echo $ZAI_API_KEY

# 2. 最小连通性验证(预期模型回复 ok)
codex exec --profile glm --skip-git-repo-check -s read-only "reply with just: ok"

# 3. 正常使用
codex --profile glm            # 交互会话,全程 glm-5.3
codex exec --profile glm "..." # 一次性任务
```

若第 2 步返回 401/鉴权错误 → key 无效或与国内站不匹配；若 404 → base_url 被改动过，应回到 `https://open.bigmodel.cn/api/v1`。

## 六、待确认的开放问题

1. **Coding Plan 的 key 是否兼容 `/api/v1` + Responses 协议**：GLM Coding Plan 官方文档（docs.z.ai/devpack/quick-start）示例即 `wire_api = "responses"` 形态，国际站为 `https://api.z.ai/api/v1`；国内站 `open.bigmodel.cn/api/v1` 路由已验证存在，但「Coding Plan 订阅 key（而非按量付费 key）能否通过该端点鉴权」需要拿到 key 后实测确认。
2. **`model_catalog_json` 与 reasoning level**：models.json 是本地自建目录（slug `glm-5.3`，"Z.ai's latest flagship model"）；若实际请求报模型不存在，核对 BigModel 模型列表里的官方 slug 是否为 `glm-5.3`。
3. **上游文档**（国际站）：[Z.AI GLM Coding Plan Quick Start](https://docs.z.ai/devpack/quick-start)、[openai/codex issue #9612（Z.AI GLM 集成）](https://github.com/openai/codex/issues/9612)。

## 七、相关文件清单

| 文件 | 作用 | 状态 |
| --- | --- | --- |
| `C:\Users\SanQian\.codex\config.toml` | 主配置（默认 OpenAI + ZAI provider 条目） | 已就绪 |
| `C:\Users\SanQian\.codex\glm.config.toml` | GLM profile（glm-5.3 / xhigh） | 已就绪 |
| `C:\Users\SanQian\.codex\models.json` | glm-5.3 本地模型目录 | 已就绪 |
| `C:\Users\SanQian\.codex\config.toml.bak-before-glm` | 接入 GLM 前的备份（2026-10-10） | 留档 |
| 环境变量 `ZAI_API_KEY` | ZAI provider 鉴权 | **缺失,待设置** |
