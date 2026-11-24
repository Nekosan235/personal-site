# 交接文档：会议记录（Meetings）功能

> **2026-11-24 更新**：已新增设置页、多转写服务（AssemblyAI / ElevenLabs / OpenAI）与 Codex 会议纪要，见 `HANDOVER-SUMMARY.md`。下文第 6 节里 `POST /:id/summary` 返回 501 的描述已过时：未配置纪要服务时仍返回 501，配置后返回 202。

> 交接对象：Claude（最终审查与优化）
> 交接人：DeepSeek Harness 会话
> 日期：2026-11-23
> 仓库路径：`D:\DeepSeek\personal-site`
> 状态：功能已完成并通过测试与真实端到端验证，等待独立审查与优化

---

## 0. 先读这一段

这个仓库原本是「个人空间」站点：原生 Node.js 后端（手写路由）+ 纯 HTML/CSS/ES modules 前端，**没有构建步骤、没有框架**。本次在其上新增了一个独立的一级功能「会议记录」（`/meetings`）：上传会议录音 → 服务器排队 → 调用 AssemblyAI 转写 → 按会议归档；录音可删除释放空间，转写稿长期保留。

**明确不在本次范围**：Codex 纪要生成（接口只留了 501 占位）。其余按需求全部实现。

**本机没有 git**：代码是通过 GitHub zip 下载解压的，没有历史提交。开始审查前请先 `git init` 并提交一份当前基线，否则无法区分「原有代码」与「本次改动」。本次改动文件清单见第 10 节。

---

## 1. 30 秒速览

| 维度 | 内容 |
| --- | --- |
| 功能入口 | 侧边栏「会议记录」→ `/meetings` |
| 后端模块 | `server/meetings/`（store / queue / service / transcribe / render / handler） |
| 前端页面 | `public/assets/pages/meetings.js` |
| 存储 | `DATA_DIR/meetings/<id>/`，每条会议一个目录 |
| 转写服务 | AssemblyAI `assemblyai-stt-3-7`，中英混说 + 说话人分离 |
| 状态机 | `draft → queued → transcribing → done / failed` |
| 测试 | 新增 14 条，全量 **261/261 通过** |
| 真实链路 | 已用 20 秒真实录音跑通（见第 9 节） |

---

## 2. 环境与运行

### 2.1 运行时

- Node.js **24.x**（`engines: >=24.14.0 <25`）。本机可用路径：
  `C:\Users\123\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- 包管理器：本机没有 npm，用自带 pnpm 安装（`node <pnpm.mjs> install --prod --ignore-scripts`）。
  生产部署仍按 README 用 `npm ci --omit=dev`，只装 `ssh2`、`ws`。
- 依赖已装到 `node_modules/`（gitignored）。**本次没有新增任何依赖。**

### 2.2 跑测试

```powershell
cd D:\DeepSeek\personal-site
& "<node.exe>" --test --test-concurrency=1 "tests/*.test.js"
```

注意：
- 必须用 glob `tests/*.test.js`，直接传 `tests/` 会被当成模块路径报错。
- 本机全量约 35–40 秒。
- Windows 上若测试偶发 `EBUSY ... sessions.sqlite`，是 SQLite 文件句柄未及时释放；已通过 `queue.drain()` 缓解，但 teardown 仍建议加 `rm(..., { maxRetries: 3 })`。

### 2.3 本地起服务（联调）

```powershell
$env:NODE_ENV='development'; $env:HOST='127.0.0.1'; $env:PORT='3111'
$env:SITE_ORIGIN='http://127.0.0.1:3111'; $env:COOKIE_SECURE='false'
$env:MONITORING_MODE='mock'; $env:DATA_DIR='D:\DeepSeek\personal-site-devdata'
$env:AUTH_USERNAME='dev'
$env:AUTH_PASSWORD_HASH='<由 server/auth/password.js 的 hashPassword 生成>'
$env:AUTH_SECRET='<32+ 位随机串>'
$env:ASSEMBLYAI_API_KEY='<你的 key>'
& "<node.exe>" server/index.js
```

首次登录用 `POST /api/auth/login`（需要从 `/login` 页面取 CSRF）。临时联调脚本在 `D:\DeepSeek\e2e\`（`e2e.mjs`、`diag.mjs`），**未入库**，仅供参考。

### 2.4 网络注意事项（重要）

这台机器访问境外 API 经常出现 TLS reset（`ECONNRESET` / `SSL: UNEXPECTED_EOF_WHILE_READING`）。因此 `transcribe.js` 对上传/提交/轮询都做了重试。审查时不要把「偶发网络失败」误判为逻辑 bug；可用 `D:\DeepSeek\e2e\diag.mjs` 单独验证网络路径。

---

## 3. 需求与实现对照

原始需求：

1. 加到工具箱，或单独开一个分类叫「会议记录」→ **实现为独立一级导航 `/meetings`**（未放进工具箱 grid，避免重复入口）。
2. 有上传录音的地方 → 拖拽 + 点选，XHR 带进度。
3. 能显示已留存的录音文件，分待转写 / 已转写 / 正在转写 → 状态徽章 + 统计卡 + 归档卡片。
4. 支持列队 → 服务端 FIFO 队列，显示「队列第 N 位」。
5. 转文字完成后有标记 → `已转写` 徽章 + 模型/语言/字数信息。
6. 可选择删除录音释放空间，同时保留转文字后的原始文件 → 「删除录音（保留转写）」只删 `audio.*`，`transcript.json/md/txt` 保留。
7. 转换完成的可以扔给 codex 整理成回忆纪要 → **本次不做**，`POST /api/meetings/:id/summary` 返回 501，前端不暴露入口。
8. 整个页面归纳整齐，有各自的归档文件夹 → 每条会议一个目录（见第 5 节）。
9. 「先旁路做一个出来」→ 功能独立，未改动原有监控/终端/媒体等模块行为。

---

## 4. 文件清单（本次新增/修改）

### 4.1 新增

| 文件 | 职责 |
| --- | --- |
| `server/meetings/store.js` | 文件系统存储：目录、meta 原子写、音频挂载/删除、转写稿落盘、启动恢复、临时文件清理 |
| `server/meetings/queue.js` | FIFO 队列：并发控制、排队位置、`drain()` |
| `server/meetings/service.js` | 单条转写编排：状态流转、音频 token 校验、失败落库 |
| `server/meetings/transcribe.js` | AssemblyAI 客户端：上传/提交/轮询、网络重试、结果归一化 |
| `server/meetings/render.js` | 转写稿格式化：中文按字空格清理、Markdown/txt 生成、时长格式 |
| `server/meetings/handler.js` | HTTP 路由与参数校验、上传流、Range 播放、删除逻辑 |
| `public/assets/pages/meetings.js` | 页面渲染与交互 |
| `tests/meetings.test.js` | 14 条测试（注入 fake client，不联网） |

### 4.2 修改（均为最小侵入）

| 文件 | 改动 |
| --- | --- |
| `server/config.js` | 新增 `meetings*` / `assemblyAi*` 配置项 + `ASSEMBLYAI_BASE_URL` 校验 |
| `server/index.js` | 装配 store/queue/service/handler；挂载 `/api/meetings`；`server.close` 等待队列 drain |
| `server/modules/catalog.js` | 新增 `{ id:'meetings', path:'/meetings', title:'会议记录', nav:true, status:'ready' }` |
| `public/assets/app.js` | import + 注册 `meetings` 页面；navigation 版本号 → 4.1.0 |
| `public/assets/components/icons.js` | 新增 `meetings` 图标 |
| `public/assets/components/navigation.js` | icons 版本号 → 1.11.0 |
| `public/index.html` | `styles.css` / `app.js` 版本号 → 4.1.0 |
| `public/assets/styles.css` | 新增 `/* ── 会议记录（/meetings） ── */` 区块；`:root` 新增 `--overlay` |
| `README.md` | 功能列表 + 「会议记录」整节 + 环境变量示例 |
| `deploy/site.env.example` | 新增会议记录相关环境变量说明 |

### 4.3 版本号约定（容易踩坑）

仓库用 `?v=x.y.z` 做缓存击穿。改了被 import 的文件必须同时改引用处的版本号，否则浏览器会用旧缓存。本次已处理：
`icons.js 1.11.0` → `navigation.js 4.1.0` → `app.js 4.1.0` → `index.html`；`styles.css 4.1.0`；`meetings.js 1.0.0`。

---

## 5. 数据模型

### 5.1 目录布局

```
DATA_DIR/
└── meetings/
    └── <id>/                    # id 形如 towumh339b9ff9d6，^[a-z0-9]{8,32}$
        ├── meta.json            # 状态与元数据（原子写：tmp + rename）
        ├── audio.<ext>          # 原始录音，删除后不存在
        ├── transcript.json      # 归一化转写结果（含 utterances）
        ├── transcript.md        # 带说话人 + 发言统计的可读稿
        └── transcript.txt       # 纯文本
```

上传临时文件：`upload-<ms>.part`；meta 临时文件：`meta.json.<hex>.tmp`。两者都会在启动恢复时清理。

### 5.2 `meta.json`

```jsonc
{
  "id": "towumh339b9ff9d6",
  "title": "PG 产线周会",
  "createdAt": 1795362569145,
  "updatedAt": 1795362569212,
  "status": "done",                  // draft | queued | transcribing | done | failed
  "audio": {                         // 未上传时为 null
    "filename": "weekly.wav",        // 仅展示，不参与路径拼接
    "ext": ".wav",                   // 白名单内
    "bytes": 640044,
    "mime": "audio/wav",
    "deleted": false,
    "uploadedAt": 1795362569000      // 用于识别「同一份音频」
  },
  "transcript": {                    // 未转写时为 null
    "model": "assemblyai-stt-3-7",
    "language": "zh",
    "durationMs": 1816900,
    "speakers": ["A", "B", "C"],
    "completedAt": 1795362600000,
    "chars": 8294,
    "bytes": 123456
  },
  "summary": null,                   // Codex 预留
  "error": null,                     // failed 时的中文原因
  "queue": { "enqueuedAt": null, "startedAt": null, "finishedAt": null }
}
```

### 5.3 状态机

```
create ──► draft
draft ──上传音频成功──► queued ──worker 启动──► transcribing ──成功──► done
                                                    └──失败──► failed ──重试──► queued
queued/transcribing ──删除录音──► done（已有转写稿）/ failed（无转写稿）
```

启动恢复（`store.recover()`）：
- `transcribing` → 改回 `queued` 并重新入队（防止崩溃卡死）
- `queued` 但没有音频 → 标记 `failed`（上传未完成）
- `draft` 不动（用户可能只是没传完，界面显示「待上传」）

**设计要点**：`draft` 是为了区分「建了记录但还没音频」与「有音频在排队」。旧实现里两者共用 `queued`，会导致幽灵任务。

### 5.4 转写结果 `transcript.json`

```jsonc
{
  "model": "assemblyai-stt-3-7",
  "language": "zh",
  "durationMs": 1816900,
  "speakers": ["A", "B", "C"],
  "text": "我们来看一下那个背景……",
  "utterances": [
    { "speaker": "A", "start": 0, "end": 30000, "text": "我们来看一下那个背景……" }
  ],
  "jobId": "...",
  "completedAt": 1795362600000,
  "mime": "audio/wav"
}
```

**注意**：AssemblyAI 返回的 `words` 数组故意不落盘（2 小时会议可达数 MB，前端也用不到）。若后续要做词级时间轴/字幕，需要重新加回并考虑单独文件存储。

---

## 6. HTTP API 合同

前缀 `/api/meetings`。除列表/详情外，**所有读接口要求登录会话**；**所有写接口额外要求同源 Origin + `X-CSRF-Token`**（值取自 `GET /api/session` 的 `csrfToken`）。

| 方法 | 路径 | 说明 | 成功 | 主要错误 |
| --- | --- | --- | --- | --- |
| GET | `/api/meetings` | 列表 + 统计 + 队列长度 + 上传上限 | 200 `{ meetings, stats, queueSize, limits }` | 401 |
| POST | `/api/meetings` | 新建（body `{ title?: string }`） | 201 `{ meeting }`（status=draft） | 400 解析失败；403 CSRF/Origin |
| GET | `/api/meetings/:id` | 单条详情 | 200 `{ meeting }` | 404 |
| DELETE | `/api/meetings/:id` | 删除整条（含转写稿） | 200 `{ ok: true }` | 404 |
| POST | `/api/meetings/:id/audio?name=` | **原始二进制**上传，`Content-Type: audio/*` 或 `video/mp4`/`video/webm`/`application/octet-stream` | 201 `{ meeting }`（status=queued） | 409 正在上传/正在转写；413 超限；415 格式不支持；429 并发上传过多；400 空文件 |
| GET | `/api/meetings/:id/audio` | 播放/下载录音，支持单段 Range | 200 / 206 | 404 无音频；416 非法 Range |
| DELETE | `/api/meetings/:id/audio` | 删除录音，保留转写 | 200 `{ meeting }` | 404 |
| POST | `/api/meetings/:id/transcribe` | 重新排队 | 200 `{ meeting }` | 409 无音频/正在转写 |
| GET | `/api/meetings/:id/transcript?format=json\|md\|txt&download=1` | 转写稿；`md/txt` 返回文本并带 `Content-Disposition` | 200 | 400 format 非法；409 还没转写稿；404 |
| POST | `/api/meetings/:id/summary` | Codex 占位 | — | **501** |
| POST | `/api/meetings/:id/audio/delete` | `DELETE /audio` 的别名（保留但未在 README 记录） | 200 | 同上 |

### 6.1 `stats` 形状

```json
{
  "total": 3,
  "counts": { "draft": 0, "queued": 1, "transcribing": 0, "done": 2, "failed": 0 },
  "audioBytes": 1280000,
  "transcriptCount": 2
}
```

### 6.2 `meeting` 形状（`publicMeeting()`）

`{ id, title, createdAt, updatedAt, status, error, audio, transcript, summary, queuePosition }`
其中 `audio` / `transcript` 为摘要对象（不含磁盘路径），`queuePosition`：0 = 正在跑，N≥1 = 队列第 N 位，null = 不在队列。

### 6.3 错误约定

所有错误体统一 `{ "error": "中文提示" }`。用户可见文案集中在 `handler.js` 的 `MEETINGS_MESSAGES`，**新增错误请沿用该表，不要把 Node/fs 原始错误直接返回给前端**（已修过一处）。

---

## 7. 后端实现要点（审查重点）

### 7.1 存储原子性
`save()` 用「写临时文件 → rename」避免读到半截 JSON。`patch()` 是读-改-写；**已知限制**：没有逐 id 互斥锁，两个并发 patch 可能丢更新。当前靠单用户 + 转写并发 1 + 音频 token 校验缓解。

### 7.2 音频 token 防错挂
`store.audioToken(meta)` = `filename|bytes|uploadedAt|deleted`。`service.run()` 在转写前记下 token，拿到结果后再读一次 meta：
- token 不一致（录音被替换/删除）→ **丢弃结果，不写 transcript**
- 失败分支同样先比对 token，避免覆盖 handler 已决定的最终状态

这是修复「转写中替换录音导致转写稿错挂」的关键，改动时不要删。

### 7.3 队列
FIFO + 并发 `MEETINGS_CONCURRENCY`（1–4，默认 1）。`stop()` 只清等待队列；`drain()` 等待在跑的任务，`server.close` 会先 drain 再关闭，避免测试 teardown 与写盘竞态。

### 7.4 上传
`streamToFile()` 边收边写，超限立即中断并删除 `.part`；`Content-Length` 预检；全局并发上传上限 2；按会议 id 加锁防重复上传。扩展名白名单见 `store.js` 的 `AUDIO_EXTENSIONS`。

### 7.5 转写客户端
- `withRetry` 对网络错误（`fetch failed`、`ECONNRESET`、`UND_ERR_*`、超时）重试；上传 2 次，提交 4 次。
- 轮询遇到网络错误最多连续重试 8 次，整体受 `MEETINGS_TIMEOUT_MS` 约束。
- 进度：5 秒轮询（`MEETINGS_POLL_INTERVAL_MS`）。
- 结果归一化时调用 `cleanCjkSpacing()` 去掉中文按字空格，并把连读缩写合并（`F Y 二 八` → `FY 二 八`）。

### 7.6 安全面
- id 正则校验后才拼路径；文件名只存储不拼路径；扩展名双重白名单。
- CSP 为 `script-src 'self'`，前端全部用 `textContent`，无 `innerHTML`、无内联 style。
- 录音响应带 `Accept-Ranges`，单段 Range 正确返回 206/416。
- 转写稿文本响应使用 `filename*=UTF-8''...`，避免头注入。

---

## 8. 前端实现要点（审查重点）

- **上传**：隐藏 `<input type=file>` + 拖拽区；隐藏 input 的 click 已 `stopPropagation`（否则程序化 click 会冒泡回拖拽区无限递归）。
- **上传失败清理**：若已创建记录但上传失败，前端尽力 `DELETE` 该记录；**该清理请求故意不带 route signal**（路由切换时 signal 已 abort）。
- **轮询**：`createPoller` 每 4 秒拉列表；用 `meetingsSignature()` 只比较「可见字段」，未变化不重渲染，避免每 4 秒抽走点击/焦点。
- **弹窗**：原生 `<dialog>`，带 `aria-labelledby`；转写稿请求带序号，防止快速切换时旧响应覆盖新内容。
- **状态**：`draft` 显示「待上传」，只给「删除记录」；`queued/transcribing` 不显示「删除录音」按钮。
- **可访问性**：通知区 `role="status" aria-live="polite"`；拖拽区可键盘触发。
- **上限**：前端不再硬编码 200 MB，改用 `GET /api/meetings` 返回的 `limits.maxUploadBytes`。

---

## 9. 测试与验证

### 9.1 新增测试（14 条）

鉴权/CSRF、上传后排队并归档、删录音保留转写、删记录移除目录、格式/大小拒绝、失败可重试、draft 不排队、排队中删录音取消任务、Range 播放、非法 format、Codex 501、崩溃恢复（含无音频的 queued → failed）。

### 9.2 全量

`node --test --test-concurrency=1 "tests/*.test.js"` → **261 tests / 261 pass**（原有 247 条全绿，无回归）。

### 9.3 真实端到端（已执行两次）

用会议录音前 20 秒真实调用 AssemblyAI，结果：
- 登录 200，`/meetings` 返回 HTML，导航含 meetings
- 创建 → `draft`；上传 201 → `queued`
- 轮询 → `transcribing` → `done`，`model=assemblyai-stt-3-7`、`language=zh`、中文断词正确
- `transcript.md` 生成正常（含 `## 发言统计`）
- 删除录音 200 → 转写稿仍 200 → 删除记录 200 → 再查 404
- 累计花费约 $0.007

---

## 10. 已知限制与遗留风险（按优先级）

### 已修复（上一轮独立审查发现）

| 级别 | 问题 | 修复方式 |
| --- | --- | --- |
| HIGH | 转写中替换录音，转写稿会挂到新音频上 | 上传/重试在 transcribing 时返回 409；service 用 audioToken 二次校验 |
| HIGH | 排队中删除录音后进入 failed，重试按钮死路 | 删除时 dequeue 并按有无转写稿落 done/failed；进行中隐藏删除按钮 |
| HIGH | `queued` 语义混淆，上传未完成的幽灵任务 | 新增 `draft` 状态；启动恢复把无音频 queued 标 failed |
| MED | 上传锁在 mkdir 失败时泄漏 | try/finally |
| MED | 原始 fs 错误（含服务器路径）返回前端 | 统一中文文案，原始错误只进日志 |
| MED | 临时文件残留 | 启动恢复清理 `upload-*.part` / `meta.json.*.tmp` |
| MED | `words` 数组落盘过大 | 不再落盘 |
| MED | 清理请求复用已 abort 的 signal | 去掉 signal |
| MED | 通知区无 aria-live | 加 `role=status` |
| MED | 队列未 drain 导致 teardown 竞态 | `queue.drain()` + `server.close` 等待 |
| MED | patch 在 try 外抛错导致任务静默丢失 | 移入 try，队列 catch 记录日志 |
| LOW | `Range: bytes=-` 返回 206 | 改 416 |
| LOW | 文件名截断保留了尾部 | 改为保留头部 |
| LOW | 非法 format 未校验 | 返回 400 |
| LOW | failed 但有转写稿时前端看不到 | 按 `meeting.transcript` 显示入口 |

### 仍然存在（有意保留 / 待优化）

| 级别 | 问题 | 现状与建议 |
| --- | --- | --- |
| MED | 没有逐用户上传限流 | 单用户站，已限并发 2。多用户前需加 `LoginRateLimiter` |
| MED | `meta.json` 无逐 id 互斥 | 并发 patch 可能丢更新；建议加 promise-chain 锁 |
| MED | 上传阶段无独立总超时 | 上传 2 次尝试、单次最长 min(timeout, 30min)，极端链路可能久 |
| MED | 语言超出 32 种时无 fallback | 需要时把 `universal-2` 加进 `speech_models` |
| LOW | 轮询 O(N) 顺序读全部 meta | 几十条内无感；上百条建议内存索引 |
| LOW | 前端模块无 DOM 测试 | 仓库本身也没有 DOM 测试框架 |
| LOW | 音频时长依赖 AssemblyAI 返回 | 未本地解析音频头 |
| LOW | `audio/delete` 别名未写进 README | 可删或补文档 |
| LOW | 未做 i18n | 全站本来就是中文硬编码 |

---

## 11. 给审查者的建议切入点

按性价比排序：

1. **并发与状态机**：`service.run` + `deleteAudio` + `uploadAudio` 三者交叉的时序；`meta.json` 互斥。
2. **资源安全**：上传中断/磁盘满/进程被杀后的残留；`recover()` 的覆盖度。
3. **错误与可观测性**：失败原因是否够诊断；日志是否泄露密钥/路径。
4. **前端体验**：轮询重渲染、弹窗请求竞态、移动端布局（760px 断点）。
5. **文档一致性**：README 接口表与实际路由（含 `audio/delete` 别名）。
6. **可维护性**：`handler.js` 已 500+ 行，可拆 `routes/upload.js` 等；但拆分会增加审查面，谨慎。

---

## 12. 变更清单速查（供 diff / review）

```
新增：server/meetings/{store,queue,service,transcribe,render,handler}.js
新增：public/assets/pages/meetings.js
新增：tests/meetings.test.js
修改：server/config.js, server/index.js, server/modules/catalog.js
修改：public/assets/app.js, public/assets/components/{icons,navigation}.js
修改：public/index.html, public/assets/styles.css
修改：README.md, deploy/site.env.example
```

回滚方式：删除 `server/meetings/`、`public/assets/pages/meetings.js`、`tests/meetings.test.js`，撤回上述修改文件的对应 hunk，并删掉 `DATA_DIR/meetings/`（如有）。

---

## 13. 术语与命名

- **meeting**：一条会议记录（一个归档目录）
- **utterance**：转写后的一段连续发言（带 speaker / start / end）
- **draft**：已建记录、尚未有音频
- **token**：音频身份标识（见 7.2），不是鉴权 token
- **archive**：归档区，即 `DATA_DIR/meetings/`
