# 会议记录（/meetings）最终审查与修复报告

> 审查人：Claude ｜ 日期：2026-11-23 ｜ 基于 `D:\DeepSeek\personal-site` 的交接版本
> 提交：`0166b64`（DeepSeek 交付基线）→ `c4676b4`（本次修复），父提交 `3c5a156`（visual 4.0）

## 结论

交付版本没有 BLOCKER，但有 4 个 HIGH 必须在上线前修：录音拖动进度条读到的字节是错的；两种并发时序会让记录永久卡在 `queued` 或 `transcribing`（只能重启解）；停服会一直等正在跑的转写，和 systemd 的 `TimeoutStopSec=20` 冲突，每次部署都会被 SIGKILL。这些问题加上 5 个影响正确性的 MEDIUM 都已修复，每个修复都补了测试。会议记录测试从 14 条增加到 27 条，全部通过；全量测试 274 条，273 条通过，唯一的失败与本功能无关（见第 3 节）。没有新增依赖，公开 API 的路由、请求和响应结构都没变。

## 1. 问题清单与修复情况

行号指基线 `0166b64`；修复后的位置写在括号里。

### HIGH（已全部修复）

| # | 位置 | 问题与影响 | 修法 | 测试 |
| --- | --- | --- | --- | --- |
| H1 | `store.js:217`、`handler.js:452` | `openAudio()` 忽略 Range，206 响应总是从第 0 字节开始发，和 `Content-Range` 对不上，还会超过 `Content-Length`。浏览器拖动进度条、Safari 播放都会出错。原测试只检查了响应头。 | `openAudio(id, meta, {start,end})` 改为按范围读取（`store.js:296`、`handler.js:490`） | `byte-range responses carry exactly the requested bytes`：逐字节比对 3 种 Range 与完整下载 |
| H2 | `queue.js:51`、`handler.js:303` | 某 id 正在运行时再 `enqueue` 会被静默忽略。典型场景：记录排队时开始替换上传，上传期间 worker 拿到旧录音；新录音落盘后入队失败，旧结果又因 token 不一致被丢弃。最终状态停在 `queued`，但队列里已经没有它，重启前永远不会转写。 | 对运行中的 id 打 rerun 标记，当前任务结束后自动再跑一次；`dequeue` 同时清掉标记 | 队列单测 `enqueued again while its job runs…`，端到端测试 `a recording replaced while the old one is being picked up…` |
| H3 | `service.js:38` | worker 无条件把状态写成 `transcribing`。如果删除录音恰好发生在 worker 读 meta 和写状态之间，handler 刚写入的 `failed` 会被覆盖，之后转写失败也因 token 不一致直接返回。结果记录卡在 `transcribing`：上传和重试都返回 409，前端也隐藏了删除录音按钮，只能重启解决。 | 新增 `store.update()`：按会议加锁，执行条件读改写（`store.js:63/161`）。worker 只在「仍是 queued 且录音 token 相同」时才转为 transcribing（`service.js:49`），失败、成功和中止也都走条件写 | `deleting the audio as the worker starts…`（用 gatedStore 精确卡住这个时间窗） |
| H4 | `index.js:600-611`，配合 `deploy/personal-site.service` 的 `TimeoutStopSec=20` | `server.close` 要等队列 drain 完才停止监听。一个转写可能要 45 分钟以上，所以停服时有任务在跑，20 秒后就会被 SIGKILL，期间服务还在继续接请求。 | `queue.stop()` 通过 AbortSignal 中止在跑的任务。客户端的 fetch、重试和 sleep 都响应这个信号，service 把任务放回 `queued`，下次启动由 `recover()` 接着跑。现在先关监听，再 drain，最后关 SQLite | `shutting down aborts an in-flight transcription…`（3 秒内关闭，meta 为 queued，recover 能找回），以及客户端单测 `stops polling as soon as it is aborted` |

### MEDIUM（影响正确性的已修复）

| # | 位置 | 问题 | 修法 | 测试 |
| --- | --- | --- | --- | --- |
| M1 | `store.js:118` | `patch()` 读改写没有互斥，会丢更新（交接文档已列为已知问题） | `patch` 改为基于 `update()`，所有写入按会议串行执行 | 由 H2、H3 和 M3 的测试覆盖 |
| M2 | `handler.js:288-302` | 上传落盘用的是请求开始时（可能几分钟前）读到的旧 meta，而且分成三次写入：删旧文件、挂音频、改 queued。中间崩溃会留下「有音频却是 draft」的记录，界面上只剩「删除记录」一个操作。 | `attachAudio(..., extra)` 在锁内一次完成：扩展名不同就先删旧文件，再 rename 并写入 queued（`store.js:182`、`handler.js:300`）；会议已被删时返回 404 并清理 .part | `re-uploading in another format replaces the old recording…` |
| M3 | `store.js:89-91` | `save()` 每次都 `mkdir`。worker 的写入如果晚于「删除记录」，已删除的目录会带着 meta.json 复活。 | `save` 不再创建目录（只有 `create` 创建），`remove` 也走同一把锁 | `removing a meeting while it is transcribing does not resurrect its folder` |
| M4 | `service.js:66` | 任何异常的 `message` 都原样写进 `meta.error` 显示给用户，包括带服务器绝对路径的 fs 错误，违反仓库「不把原始错误返回前端」的约定 | 只透传 `TranscriptionError` 的中文文案，其余显示「转写失败，请稍后重试。」，原始错误只写日志（`service.js:15`） | `internal errors are logged but never shown to the user verbatim` |
| M5 | `handler.js:117-157` | `streamToFile` 在 fd 关闭前就 resolve/reject，随后的 rename/rm 在 Windows 上会遇到 EBUSY，而且 catch 里的 `rm` 抛错会覆盖原来的错误。客户端断开只依赖已废弃的 `aborted` 事件。 | 等 `close` 事件再结束；同时监听 `req.close` 并检查 `!req.complete`；清理时的 `rm` 不再抛错 | `an interrupted upload releases the lock and leaves no partial file` |
| M6 | `meetings.js:310` | 录音已删除且失败的记录仍显示「重试转写」，点了必然 409（交接文档说「重试按钮死路」已修，其实只修了一半） | 抽出纯函数 `meetingActions()`（`meetings.js:69`），没有录音就不显示重试 | `card actions never offer a retry that the server would refuse` |
| M7 | `transcribe.js` 全文件 | AssemblyAI 客户端（重试、401、轮询、中文清理）没有任何测试 | 用 fake fetch 补了 3 条，不联网 | 重试与中文清理、401 不重试、中止 |
| M8 | `README.md` | 文档写「除列表与详情外都需要 CSRF」，实际是所有写接口都需要，读接口不需要；`audio/delete` 别名、`MEETINGS_DIR`、`MEETINGS_POLL_INTERVAL_MS`、`MEETINGS_TIMEOUT_MS` 都没有写 | 更正 CSRF 说明，补别名一行和可选环境变量，并补充停服、替换录音时的行为说明 | 只改文档 |

顺带做的小改动（都在上面修复的代码路径里）：音频 token 加了随机 `uploadId`，避免同一毫秒内上传同名同大小的文件时 token 相同；`MEETING_STATUSES` 补上了 `draft`；`recover()` 失败时会打日志，不再静默吞掉。

### LOW / 待你决定（按你的要求只列出来，没有改）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L1 | 架构 | 停服或崩溃后恢复会**重新上传并重新计费**，因为 AssemblyAI 的 jobId 没有保存 | 把 `jobId` 写进 meta，恢复时直接轮询已有任务。收益最大的后续优化，大约 1 小时 |
| L2 | `handler.js` 删除路径 | 转写中删除录音或记录，不会取消 AssemblyAI 那边的任务，照样计费 | 前端已经在 queued/transcribing 时隐藏了删除录音；如需要，可调 AssemblyAI 的 DELETE 接口 |
| L3 | `store.recover()` | 重新入队按 `createdAt` 倒序，不是原来的 FIFO 顺序 | 改成按 `queue.enqueuedAt` 升序 |
| L4 | `handler.js` 413 路径 | 超限后 `req.resume()` 会把剩余的请求体全部读完 | 发完 413 后可以直接 `req.destroy()` |
| L5 | `meetings.js` | 列表签名不含 `queuePosition`；busy 状态的按钮没有 disabled，可以连点 | 都只要改一行 |
| L6 | `meetings.js` | 页面没有播放录音的入口（接口支持 Range） | 功能需求，按需添加 |
| L7 | `store.js:39` | `MeetingStore` 构造时用 `mkdirSync`，`MEETINGS_DIR` 配错会让整站启动失败 | 属于 fail-fast，可以接受；需要的话改成会议功能单独降级 |
| L8 | 其他 | 多段 Range 回退成 200 整文件；列表每次请求都读全部 meta（O(N)）；上传进度条用了 `.style.width`（CSSOM 不受 CSP 限制，dashboard 也是这么用的） | 都可以接受 |
| L9 | `handler.js` 530 行 | 是否拆分 | **不建议现在拆**，收益小，审查面会变大 |
| L10 | `POST /:id/audio/delete` 别名 | 删掉还是保留 | 这次选择写进文档并保留，删掉属于 API 变更 |

## 2. 未修项风险

L1 和 L2 只影响费用，不影响数据：按当前单价，一小时会议重转一次大约多花 $0.2–0.4。其余都是体验或性能问题，对单用户站来说风险很低。L1 建议在第一次正式用长会议录音之前做。

## 3. 测试结果

| | 修改前（`0166b64`） | 修改后（`c4676b4`） |
| --- | --- | --- |
| 会议记录 `tests/meetings.test.js` | 14 / 14 | **27 / 27**（连续跑 5 轮都稳定） |
| 新测试放在旧代码上跑 | 8 条失败，问题均复现 | 全部通过 |
| 全量 `tests/*.test.js` | 260 / 261 | **273 / 274** |

全量里唯一的失败是 `terminal.test.js:330`。这条测试把 SSH 空闲超时设成 200 ms，而我的 Linux 沙箱里 SSH 握手比这还慢，会话在认证失败之前就先超时了。它在**完全没有改动的原始代码**（`3c5a156`）上同样失败，而且和会议记录无关。交接文档说它在你的 Windows 机器上能通过，请在本机再跑一遍确认。测试使用的 Node 版本是 **24.22.3**，满足 `engines` 要求。

另外检查了：所有改动的 JS 文件都通过 `node --check`；`styles.css` 没有改动，`backdrop.test` 不受影响；缓存版本号已同步更新：`meetings.js?v=1.0.1`，`app.js` 中的引用随之更新，`index.html` 里 `app.js?v=4.1.1`。

## 4. diff 概要（`git diff --stat 0166b64 c4676b4`）

```
 README.md                       |  11 +-
 public/assets/app.js            |   2 +-
 public/assets/pages/meetings.js |  53 ++++--
 public/index.html               |   2 +-
 server/index.js                 |  22 ++-
 server/meetings/handler.js      | 114 ++++++++----
 server/meetings/queue.js        |  24 ++-
 server/meetings/service.js      |  93 ++++++----
 server/meetings/store.js        | 173 +++++++++++++-----
 server/meetings/transcribe.js   |  65 +++++--
 tests/meetings.test.js          | 395 +++++++++++++++++++++++++++++++++++++++-
 11 files changed, 768 insertions(+), 186 deletions(-)
```

几处关键改动：`store.update()` 加上 `withLock()` 是这次修复的核心，所有状态转换都变成「在锁内检查条件，再写入」。`service.run()` 只推进 `queued` 状态且 token 相同的记录，其余情况一律交给 handler 已做的决定。队列新增 rerun 标记和 AbortController。`server.close` 的顺序改成：中止任务，关闭监听，drain，最后关 SQLite。

## 5. 上线前 checklist

1. **环境变量**：在 `/etc/personal-site/site.env` 填 `ASSEMBLYAI_API_KEY`（文件权限 0600）。`deploy/Caddyfile` 目前没有设置 `request_body` 上限，所以由 `MEETINGS_MAX_UPLOAD_BYTES` 决定；以后如果在 Caddy 加上限，要不小于这个值。
2. **数据目录**：unit 文件启用了 `ProtectSystem=strict`，所以 `MEETINGS_DIR` 必须在 StateDirectory 里（默认 `DATA_DIR/meetings`，不用改）。目录属主为 `personal-site`、权限 0700（已由 `UMask=0077` 保证）。
3. **磁盘**：每条录音最大 200 MB，部署前确认 `/var/lib/personal-site` 所在分区有足够余量。可以看页面上的「录音占用」，或者执行 `du -sh /var/lib/personal-site/meetings`。
4. **内存**：unit 限制了 `MemoryMax=256M`。上传是流式的，峰值内存不会随文件变大，但建议第一次用一个 1 小时的录音观察 `systemctl status` 里的内存。
5. **备份**：只需要备份 `meetings/*/meta.json` 和 `transcript.*`，录音可以不备份。比如 `rsync -a --exclude 'audio.*' --exclude '*.part' /var/lib/personal-site/meetings/ backup:/…`。
6. **监控队列卡住**：以下几种情况需要告警。`GET /api/meetings` 返回的 `stats.counts.transcribing` 持续大于 0 超过 `MEETINGS_TIMEOUT_MS` 加 30 分钟；`queueSize` 大于 0 但 `transcribing` 为 0 超过 1 分钟；`journalctl -u personal-site` 里出现 `[meetings]` 错误日志。手动处理时，重启服务即可，`recover()` 会把卡住的任务重新入队。
7. **部署顺序**：先 `npm ci --omit=dev`，再在本机跑全量测试，然后 `systemctl restart personal-site`。有任务在跑时重启是安全的：任务会回到排队状态，但要重新计费，见 L1。
8. **冒烟测试**：上传一个 20 秒的录音，等转写完成；在页面上拖动录音进度条（H1 修好之后才能正常拖）；删除录音后确认转写稿还在；最后删除整条记录。
