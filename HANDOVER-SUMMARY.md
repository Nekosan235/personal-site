# 交接文档：设置页、多转写服务、Codex 会议纪要

> 日期：2026-11-24 ｜ 仓库：`D:\DeepSeek\personal-site`
> 前序文档：`HANDOVER.md`（会议记录本体）、`REVIEW-REPORT.md`（Claude 审查与修复）
> 本次改动前的完整备份：`D:\DeepSeek\personal-site-baseline-20261124\`（不含 node_modules / data）
> 测试：全量 **297 / 297**，连续 3 轮全绿（基线 274 + 新增 23，新增测试在 `tests/meetings-settings.test.js`）

---

## 0. 一句话

会议记录新增了**设置页**（切换转写服务、填 Key、编辑专有名词和纪要提示词）和**会议纪要**（把转写稿 + 提示词交给服务器本机的 Codex，结果存成 `summary.md`）。前两块已完成并测试；**Codex 那一段只按约定写好了代码和假数据测试，从没在真实 Codex 上跑过**，需要有服务器权限的 agent 完成第 5 节的任务。

---

## 1. 做了什么

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 设置页 `/meetings/settings` | ✅ 完成 | 会议记录页右上角「设置」进入；侧边栏不新增条目，仍高亮「会议记录」 |
| Key 管理 | ✅ 完成 | 每个服务单独一栏；只写不读，页面只显示「来源 + 末四位」；可清除回退到环境变量 |
| 切换转写服务 | ✅ 完成 | AssemblyAI（默认）/ ElevenLabs Scribe / OpenAI；每次转写开始时读取设置，切换不用重启 |
| 专有名词 | ✅ 完成 | 设置页编辑，覆盖 `MEETINGS_KEYTERMS` |
| ElevenLabs 客户端 | ⚠ 未联网验证 | 按官方 API 文档实现，单测用假 fetch；建议上线前用一段 20 秒录音实测 |
| OpenAI 客户端 | ⚠ 未联网验证 | 同上；单文件 25 MB 上限，超了直接拒绝 |
| 纪要提示词 | ✅ 完成 | 设置页编辑，有默认提示词和「恢复默认」 |
| 纪要队列、存档、查看、下载 | ✅ 完成 | 单并发、可重试、启动恢复、删除记录时取消、转写更新后标记过期 |
| 转写完成后自动生成纪要 | ✅ 完成 | 设置页开关，默认关 |
| **Codex 调用（codex-exec / codex-http）** | ❌ **待服务器 agent** | 代码与契约测试都在，真实环境未验证；见第 5 节 |

---

## 2. 文件清单

新增：

| 文件 | 职责 |
| --- | --- |
| `server/meetings/settings.js` | 设置读写（`DATA_DIR/meetings-settings.json`，0600）、环境变量回退、输入校验、对外脱敏视图；默认纪要提示词 `DEFAULT_SUMMARY_PROMPT` |
| `server/meetings/providers.js` | 转写服务注册表 + ElevenLabs / OpenAI 客户端；`wordsToUtterances()` 把逐词结果合成说话人段落 |
| `server/meetings/dynamic-client.js` | 每个转写任务开始时从设置取服务、Key、模型、专有名词，再交给对应客户端 |
| `server/meetings/summary.js` | 纪要输入拼装、三个纪要 provider（disabled / codex-exec / codex-http）、纪要任务队列 |
| `public/assets/pages/meetings-settings.js` | 设置页 |
| `tests/meetings-settings.test.js` | 23 条测试 |
| `HANDOVER-SUMMARY.md` | 本文件 |

修改（均为增量）：

| 文件 | 改动 |
| --- | --- |
| `server/config.js` | 新增 `MEETINGS_PROVIDER`、`ELEVENLABS_API_KEY`、`OPENAI_API_KEY`、`MEETINGS_SETTINGS_FILE`、`MEETINGS_SUMMARY_PROVIDER`、`MEETINGS_CODEX_*`、`MEETINGS_SUMMARY_TIMEOUT_MS`；校验 provider 取值、`MEETINGS_CODEX_URL` 必须回环 |
| `server/index.js` | 装配设置、注册表、动态客户端、纪要服务；转写完成后按设置自动提交纪要；停服时中止纪要任务 |
| `server/meetings/handler.js` | `GET/PUT /api/meetings/settings`（限流 20 次/分钟）；`POST/GET /:id/summary`；列表增加 `features`；`publicMeeting.summary` 只暴露状态字段；删除记录时取消纪要任务 |
| `server/meetings/store.js` | `writeSummary()` / `readSummary()`；转写结果记录 `provider`；重新转写时把已有纪要标为 `stale`；**修复 Windows 上 meta.json 原子替换偶发 EPERM**（见 7.1） |
| `server/modules/catalog.js` | 新增 `meetings-settings`（`nav: false`） |
| `public/assets/pages/meetings.js` | 「设置」按钮、缺 Key 提示、卡片纪要状态、「生成纪要 / 重新生成 / 查看纪要」、纪要弹窗 |
| `public/assets/app.js`、`public/index.html` | 注册设置页；版本号 `meetings.js 1.1.0`、`meetings-settings.js 1.0.0`、`app.js 4.2.0`、`styles.css 4.2.0` |
| `public/assets/styles.css` | 末尾新增「会议记录设置与纪要」区块，只用已有 CSS 变量 |
| `tests/meetings.test.js` | ① 未配置纪要时仍返回 501，文案断言从「Codex」改为「纪要」；② 「上传超限」测试接受 413 或连接被重置两种结果（见 7.1） |
| `README.md`、`deploy/site.env.example` | 文档与环境变量 |

---

## 3. 设置

### 3.1 存储与优先级

`DATA_DIR/meetings-settings.json`，写入用临时文件 + rename，权限 0600：

```jsonc
{
  "version": 1,
  "transcription": {
    "provider": "elevenlabs",                 // null = 用 MEETINGS_PROVIDER
    "keys":   { "elevenlabs": "sk_..." },     // 没有的 = 用对应环境变量
    "models": { "elevenlabs": "scribe_v3" },  // 没有的 = provider 默认模型
    "keyterms": ["PG", "产线"]                // null = 用 MEETINGS_KEYTERMS
  },
  "summary": {
    "provider": "codex-exec",                 // null = 用 MEETINGS_SUMMARY_PROVIDER
    "prompt": null,                           // null = 默认提示词
    "autoAfterTranscript": false
  },
  "updatedAt": 1795400000000
}
```

优先级：**设置页保存值 > 环境变量 > 内置默认**。`MEETINGS_MODEL` 只对 `MEETINGS_PROVIDER` 指定的那个服务生效，切到别的服务时用那个服务的默认模型。

### 3.2 API

```
GET /api/meetings/settings      -> 200 { settings }
PUT /api/meetings/settings      -> 200 { settings } | 400 { error, field } | 403 | 429
```

PUT 是部分更新，没写的字段不动：

```jsonc
{
  "transcription": {
    "provider": "openai",
    "keys":   { "openai": "sk-...", "assemblyai": null },  // null = 清除本页保存值
    "models": { "openai": "gpt-4o-transcribe" },           // null/"" = 恢复默认
    "keyterms": "PG, 产线\nOEE"                            // 字符串或数组；null = 用环境变量
  },
  "summary": { "provider": "codex-exec", "prompt": "…", "autoAfterTranscript": true }
}
```

校验：Key 8–256 个可见 ASCII 字符；模型名 `[A-Za-z0-9._:-]{1,64}`；提示词 ≤ 8000 字；专有名词去重、每个 ≤ 50 字、最多 400 个。

返回的 `settings.transcription.providers[]` 每项有 `keySource`（`saved` / `env` / `none`）和 `keyHint`（`••••ABCD`），**不包含 Key 本身**（有测试断言响应体里搜不到 Key）。

### 3.3 安全考虑（给审查者）

- Key 以明文存在 0600 文件里，和 `site.env` 同一级别的保护。没有做加密：密钥只能放在同一台机器上，加密收益很小。
- 设置接口和其他写接口一样要会话 + CSRF + 同源 Origin，另加每分钟 20 次限流。
- 浏览器端只用密码框提交，提交后清空；页面重新渲染。

---

## 4. 转写服务

三个服务都实现同一个接口 `transcribeFile({ filePath, size, mime, filename, signal })`，返回统一结构 `{ model, language, durationMs, speakers, text, utterances }`，所以队列、归档、转写稿导出完全不用改。

| 服务 | 默认模型 | 接口 | 说话人 | 中英混说 | 限制 |
| --- | --- | --- | --- | --- | --- |
| AssemblyAI | `assemblyai-stt-3-7` | 上传 → 提交 → 轮询（原有代码） | `speaker_labels` | `language_detection` | — |
| ElevenLabs | `scribe_v3` | `POST /v1/speech-to-text` multipart，同步返回 | `diarize=true` | `language_code=zh` + `secondary_language_codes=en` | 文件 < 5 GB；`keyterms` 会加收 20% |
| OpenAI | `gpt-4o-transcribe-diarize` | `POST /v1/audio/transcriptions` multipart | `diarized_json` | 自动 | **单文件 ≤ 25 MB**，30 分钟 wav 会被拒绝 |

注意：
- ElevenLabs 和 OpenAI 是**同步**接口，长录音时一个 HTTP 请求会挂很久，超时用 `MEETINGS_TIMEOUT_MS`。
- 停服时会中止请求，任务回到 `queued`，下次启动**重新上传、重新计费**（和 AssemblyAI 一样，见 REVIEW-REPORT L1）。
- ElevenLabs 的语言代码固定为 `zh` + 次要 `en`，适合中文为主的会议；如果以后有纯英文会议，需要做成可配置。
- 两个新客户端都**没有用真实 Key 跑过**，接口字段按 2026-11 官方文档实现（[ElevenLabs Create transcript](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)）。

---

## 5. ⚠ Codex 会议纪要：需要有服务器权限的 agent 完成

### 5.1 已经写好的部分

```
卡片「生成纪要」 → POST /api/meetings/:id/summary
  → summary.status = queued → 纪要队列（单并发）
  → provider.summarize({ prompt, transcript, meeting, signal })
  → 成功：写 summary.md，summary.status = done
     失败：summary.status = failed，summary.error = 中文原因
```

发给 Codex 的内容由 `buildSummaryInput()` 拼成，结构固定：

```
<设置页里的提示词>

---
## 会议信息
会议标题：…
录音时长：N 分钟
说话人：A / B / C
转写模型：…

## 转写稿
<transcript>
[00:00:00] Speaker A: …
[00:00:59] Speaker B: …
</transcript>
```

转写稿超过 40 万字符会截断并注明。返回结果会去掉外层 ```` ```markdown ```` 代码块。

### 5.2 两种接入方式（选一种实现并验证即可）

#### 方式 A：`codex-exec`（直接调用本机 Codex CLI）

代码：`server/meetings/summary.js` 的 `createCodexExecProvider`。

实际执行：

```
$MEETINGS_CODEX_BIN exec <MEETINGS_CODEX_ARGS…> --output-last-message <临时文件> -
```

- 完整输入从 **stdin** 写入（`-` 表示从 stdin 读 prompt），不经过 shell，参数是数组。
- 优先读 `--output-last-message` 写的文件，读不到再用 stdout。
- 工作目录默认是一个每次新建、用完删除的临时目录（`MEETINGS_CODEX_CWD` 可覆盖）。
- 超时 `MEETINGS_SUMMARY_TIMEOUT_MS`（默认 10 分钟）后 SIGTERM。

配置：

```dotenv
MEETINGS_SUMMARY_PROVIDER=codex-exec
MEETINGS_CODEX_BIN=/usr/local/bin/codex
MEETINGS_CODEX_ARGS=["--sandbox","read-only","--skip-git-repo-check"]
```

#### 方式 B：`codex-http`（本机桥接服务）

代码：`createCodexHttpProvider`。适合 Codex 跑在另一个用户/容器里、或者已经有 Codex Web 服务（README 里 8443 → 3001 那个）的情况。

请求（`MEETINGS_CODEX_URL` 必须是回环地址，否则启动时报错）：

```http
POST $MEETINGS_CODEX_URL
Content-Type: application/json
Authorization: Bearer $MEETINGS_CODEX_TOKEN      (可选)

{
  "prompt": "设置页里的提示词",
  "input": "buildSummaryInput() 的完整文本（提示词 + 会议信息 + 转写稿）",
  "meeting": { "id": "towumh339b9ff9d6", "title": "PG 周会" },
  "transcript": { "model": "assemblyai-stt-3-7", "language": "zh", "durationMs": 1816900, "speakers": ["A","B","C"] }
}
```

期望响应：`200 { "markdown": "# 会议纪要 …", "model": "可选" }`。非 2xx 视为失败，5xx 标记为可重试。不跟随重定向。

桥接服务本身**不在本仓库里**，需要服务器 agent 根据现有 Codex 部署来写（最简单的做法是一个只监听 127.0.0.1 的小服务，收到请求后执行 `codex exec -` 并把 `input` 写进 stdin）。

### 5.3 服务器 agent 的任务清单

1. **确认 Codex 的现状**：装在哪（`which codex`）、版本（`codex --version`）、用哪个系统用户、怎么认证（`codex login` 的凭据在哪个 HOME 下）。
2. **解决 systemd 沙箱冲突（最可能出问题的地方）**。`deploy/personal-site.service` 有这些限制：
   - `User=personal-site`、`ProtectHome=true`：进程看不到 `/root` 和 `/home`，**Codex 的登录凭据（通常在 `~/.codex/`）读不到**。
   - `ProtectSystem=strict`：只有 StateDirectory（`/var/lib/personal-site`）可写；Codex 要写会话/日志的目录要么放进去，要么用 `ReadWritePaths=` 放行。
   - `MemoryMax=256M`、`TasksMax=64`：Codex CLI 是 Node/Rust 进程，可能超内存；子进程也算在 `TasksMax` 里。
   - `RestrictAddressFamilies`：允许 INET，Codex 访问 OpenAI 没问题。

   可选方案（按推荐顺序）：
   - **用 `codex-http`**：让 Codex 以自己的用户/服务运行，personal-site 只调用回环地址，完全不用放宽 personal-site 的沙箱。推荐。
   - 或者给 personal-site 配一个专用 `CODEX_HOME`（例如 `/var/lib/personal-site/codex-home`），以 `personal-site` 用户身份 `codex login` 一次，并把 `Environment=CODEX_HOME=…` 写进 unit；同时适当调大 `MemoryMax`。
3. **确认 CLI 参数**：`codex exec --help` 里确认 `--output-last-message`、`--sandbox read-only`、`--skip-git-repo-check`、从 stdin 读 prompt（`-`）在当前版本都可用；不可用就改 `createCodexExecProvider` 的参数拼装（只改这一个函数）。
4. **只读运行**：纪要只需要读 stdin 输出文本，Codex 不应该能改文件或执行命令。务必用 `--sandbox read-only`（或当前版本的等效选项），工作目录用临时空目录。
5. **端到端验证**：
   ```bash
   # 1. 手动验证 CLI
   printf '请用一句话总结：今天讨论了 PG 产线自动化。' | sudo -u personal-site $MEETINGS_CODEX_BIN exec --sandbox read-only --skip-git-repo-check --output-last-message /tmp/out.md -
   cat /tmp/out.md
   # 2. 配好 site.env 后重启
   systemctl restart personal-site
   # 3. 页面：/meetings/settings 选「Codex（本机 CLI）」→ 保存 → 回会议记录
   #    对一条「已转写」的卡片点「生成纪要」→ 等卡片出现「已有纪要」→「查看纪要」
   ls -l /var/lib/personal-site/meetings/<id>/summary.md
   journalctl -u personal-site -n 50 --no-pager | grep meetings
   ```
6. **超时与停服**：用一段 30 分钟会议测一次耗时，按实际情况调 `MEETINGS_SUMMARY_TIMEOUT_MS`。确认 `systemctl restart` 时纪要任务被中止、回到 `queued`、重启后自动继续（`TimeoutStopSec=20`）。
7. **补测试**：如果改了 `createCodexExecProvider` / `createCodexHttpProvider` 的参数或协议，同步更新 `tests/meetings-settings.test.js` 里对应的契约测试（那几条用假的 spawn / fetch，不依赖真实 Codex）。
8. **隐私**：转写稿会发给 Codex 背后的模型服务（OpenAI）。如果有数据不出境/不出公司的要求，需要先确认 Codex 的模型配置。

### 5.4 验收标准

- [ ] 设置页「纪要服务」下拉里选中的 Codex 项不再显示「（服务器未配置）」
- [ ] 一条已转写会议点「生成纪要」后 10 分钟内出现「已有纪要」，`summary.md` 内容是合理的中文纪要
- [ ] 打开「转写完成后自动生成纪要」后，新上传的录音转写完成会自动出纪要
- [ ] Codex 失败（例如临时改错 `MEETINGS_CODEX_BIN`）时卡片显示中文原因，修好后能重试成功
- [ ] `systemctl restart personal-site` 期间正在生成的纪要不会卡死，重启后继续
- [ ] 全量测试仍全部通过：`node --test --test-concurrency=1 "tests/*.test.js"`

---

## 6. 纪要数据模型

`meta.json` 里的 `summary` 字段：

```jsonc
{
  "status": "done",            // queued | running | done | failed
  "provider": "codex-exec",
  "error": null,               // failed 时的中文原因（原始错误只进日志）
  "requestedAt": 1795400000000,
  "startedAt":   1795400001000,
  "completedAt": 1795400090000,
  "chars": 1834,
  "model": null,               // codex-http 可以回填
  "promptChars": 312,
  "stale": false               // 之后重新转写过 → true，页面提示重新生成
}
```

规则：
- 已有 `queued/running` 时再请求返回 409；没有转写稿返回 409；纪要服务未启用返回 501。
- 纪要任务开始时记下转写稿的 `completedAt`；写回时如果转写稿已经变了，结果直接丢弃。
- 删除记录会取消排队或正在运行的纪要。删除录音不影响纪要。
- 启动时 `running` 改回 `queued`，所有 `queued` 重新排队。

---

## 7. 已知限制 / 后续可做

| 级别 | 项 | 说明 |
| --- | --- | --- |
| 高 | Codex 未验证 | 见第 5 节 |
| 中 | ElevenLabs / OpenAI 未联网验证 | 字段名按官方文档；建议各用 20 秒录音实测一次（约 $0.002） |
| 中 | 纪要以纯文本显示 | 弹窗里用 `<pre>` 显示 Markdown 原文，故意不解析成 HTML（模型输出不可信）。仓库已有 `components/format-convert/markdown.js` 的转义渲染器，如需富文本可以接入 |
| 中 | ElevenLabs 语言固定 zh + en | 纯英文会议可能略差；可在设置页加语言选项 |
| 低 | 没有「测试 Key」按钮 | 填错 Key 要等转写失败才知道；可以加一个调用各家轻量接口的校验 |
| 低 | 纪要队列单并发、无优先级 | 单用户站足够 |
| 低 | 设置文件损坏时用默认值 | 会打日志；页面会显示默认设置，保存一次即修复 |
### 7.1 本次顺带修掉的两个偶发失败

压力测试（同一组测试连续跑 8 轮）时发现两个间歇性失败，都不是新功能本身的逻辑问题：

1. **`meta.json` 原子替换在 Windows 上偶发 `EPERM`**（真实 bug，影响上一轮交付的代码）。`store.save()` 用「写临时文件 → rename 覆盖」，而 Windows 在目标文件被其他句柄打开时会拒绝覆盖；页面每 4 秒轮询列表会读所有 `meta.json`，正好撞上。表现为状态写入失败（纪要变成「生成纪要失败」，转写也可能受影响）。修复：新增 `renameWithRetry()`，对 `EPERM/EACCES/EBUSY` 短暂重试（最多 8 次、累计约 0.4 秒），失败时清理临时文件；设置文件的保存也改用它，并保证磁盘写入成功后才更新内存里的设置。Linux 上 rename 覆盖打开的文件总是成功，这段重试不会触发，所以**生产服务器不受影响**，但本地 Windows 开发会受影响。
2. **「上传超限」测试**：服务端根据 `Content-Length` 直接返回 413 并关闭连接、不读请求体，客户端有时先收到 413，有时在发送中被重置。两种都是正确的拒绝，测试改为都接受，并额外断言记录仍是 `draft`、没有存下文件。

修复后同一组测试连续 10 轮、全量连续 3 轮全部通过。

---

## 8. 回滚

删除本次新增的 6 个文件，把第 2 节「修改」里的文件恢复成 `D:\DeepSeek\personal-site-baseline-20261124\` 里的版本即可。`DATA_DIR/meetings-settings.json` 和各会议目录里的 `summary.md` 可以留着，旧代码不读它们。
