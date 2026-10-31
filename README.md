# 个人空间

一个轻量、自托管的个人工具箱：原生 Node.js 后端、HTML/CSS/ES modules 前端。界面使用本地托管的 [Tabler 1.6.1](https://github.com/tabler/tabler)（MIT）UI kit，提供侧边导航、作品墙、设备监控卡片、响应式工具页面和日夜主题。保留原有认证与监控接口。页面仍然没有前端构建；Web SSH 需要在服务器上执行 `npm ci --omit=dev`，安装 `ssh2` 和 `ws`。

Tabler 样式位于 `public/assets/vendor/tabler/tabler.min.css`，上游许可及 Bootstrap 许可保存在同目录的 `LICENSE`。图片/GIF 处理复用 [wechat-toolbox](https://github.com/Nekosan235/wechat-toolbox) 中独立的像素算法与 GIF 编解码逻辑，来源许可位于 `public/assets/components/image-tools/LICENSE`。文件只在浏览器中读取并通过 ES module Worker 处理，没有文件上传 API、外部 CDN、第三方运行时依赖或构建步骤。外观控制器同时维护 `data-theme` 与 Tabler 的 `data-bs-theme`。

## 功能

- 单用户密码登录，后端保护页面、脚本和 API；SQLite 持久会话、scrypt 密码哈希、CSRF 与登录限流。同一账号跨来源地址连续失败 5 次后，15 分钟内拒绝再试。
- 作品墙：概览页 4 张主要项目卡片，另有项目页、其他练习和荣誉奖状。奖状在登录后显示。项目页留有设备三维查看位，当前不加载模型。
- 首页先显示“欢迎回来”，停留一段时间后轮换原创短句。
- 浅色、深色、跟随系统及日出日落主题。深色是终端工作台（锁定色板、细边框、等宽数字）。外观设置里选「浅色」即可回退；偏好保存在本机 `personal-space.appearance.v1`。自动识别本机时区，使用明确标注的参考城市计算日出日落，可手动覆盖。
- Linux 云服务器每 5 秒真实采样 CPU、内存、根分区容量与运行时长，CPU 占用、内存和硬盘各保留最近 60 个样本。跑网站的那台机器继续用本机采样。
- NAS 用无依赖 Python 脚本每 15 秒主动通过 HTTPS 上报；独立 HMAC、时间戳与 nonce 校验，不公开 NAS 端口。
- 其他 Linux 云主机用同一套 HMAC 上报 CPU、内存、根分区与运行时长。每台远程机器单独成卡，可与本机云主机和 NAS 同时显示。
- 多设备监控与数据卷明细，异常保留旧数据并标注时间，隐藏页面暂停请求。每张设备卡标题栏可在波形与进度条之间切换，选择记在本机 `personal-space.metric-view.v1`（默认波形，各卡共用）。CPU、内存、硬盘跟随这个开关；存储卷只显示进度条。
- 浏览器本地图片工具：边缘连通白底移除、整图去白、擦除/还原/取色画笔、原图对比、缩放移动与透明 PNG 导出；可一次导入多张。仅静态 PNG/JPEG/WebP。同一页可改用智能抠图，图片经本站转发给上海的 rembg，不是浏览器里的模型。
- 浏览器本地 GIF 工具：逐帧去白、逐帧画笔/撤销、播放预览与透明 GIF 导出，保留帧延时和循环信息。
- 图片最大 10 MB/3200 万原始像素；GIF 最大 8 MB、60 帧、15 秒/3200 万逻辑像素，导出最大 480px 长边/20 MB。文件仅在浏览器本地处理，不上传服务器。
- 格式转换：浏览器本地处理图片、Markdown、JSON、YAML、CSV、Base64、URL 和文本，见下文。HEIC、PDF 与音视频保持不可用。
- 无水印下载：粘贴小红书或抖音分享文字，解析图片或视频后经站点代理保存。抖音入口 2 不需要本机 DouK，也不需要 Cookie。见下文。
- 终端：登录后从侧边栏进入 `/terminal`。右侧列出监控里已经登记的服务器，点一台才连接；断开会立刻关掉 SSH。见下文。
- Agent 与智能抠图保持清晰标注的待开放入口；Codex Web 外链由环境变量配置。

## 格式转换

工具箱里的「格式转换」在浏览器本地完成。转换逻辑是纯 JavaScript，由 Node 测试直接运行；页面不上传文件，不请求远程地址，也不执行系统命令。

- 图片：PNG、JPG/JPEG、WebP、GIF 互转。GIF 只保留第一帧。安全的 SVG（没有脚本、外链或嵌入对象）可以转为 PNG 或其他位图。JPG 会把透明区域铺成白色。
- 文档：Markdown 转为转义后的 HTML；TXT 和 Markdown 可以纯文本预览。
- 数据：JSON 与块式 YAML 子集互转，CSV 与 JSON 互转，Base64 编解码，URL 编解码。YAML 使用空格缩进，不支持锚点、标签和多行文本块。CSV 第一行是表头，字段保持文本。
- 文本：大小写、首尾空白、连续空格，以及 CRLF 与 LF。
- 未提供：HEIC、PDF、音频和视频。不引入原生解码库，也不调用 ffmpeg。

文本和数据上限 1 MB。图片上限 10 MB、3200 万像素；GIF 导出不超过 419 万像素。SVG 上限 512 KB。

## 无水印下载

工具箱里的「无水印下载」面向手机浏览器。页面接受整段分享文字，抽出小红书或抖音链接后调用本机已经在跑的解析服务。服务只监听回环地址，由各自的进程部署，网站不负责启动它们。

- 小红书使用 XHS-Downloader 的 `POST /xhs/detail`，请求体 `{url, download:false}`。开发分支的接口需要 `Authorization: Bearer`。令牌放在 `XHS_API_TOKEN`，或由 `XHS_API_TOKEN_FILE` 指向的文件提供（服务器上为 `/etc/media-dl/xhs-api.token`，属组 `personal-site`，权限 640）。空数据或「获取小红书作品数据失败」会提示换带 `xsec_token` 的完整分享链接。
- 抖音入口 1 使用 DouK-Downloader 的 `POST /douyin/share` 解开短链，再 `POST /douyin/detail`。默认不校验令牌。可选 `DOUYIN_COOKIE` 会放进 detail 的 `cookie` 字段。返回「获取数据失败！」时页面显示「抖音 Cookie 可能失效」。
- 抖音入口 2 不读取 `DOUYIN_COOKIE`、`DOUYIN_API_TOKEN` 或 `DOUYIN_API_URL`，也没有单独的环境变量。它从分享链接取出作品编号，向抖音网页详情接口要清晰度列表，再用本站代理下载。详情或播放地址拿不到时，页面提示改用入口 1，不会自动改走 Cookie。播放量只在详情返回时已经拿到才显示，不会为了它继续等待。
- 媒体文件只从允许的小红书、抖音 CDN 域名回源，并转发浏览器的 Range 请求。代理不会把站点来源的 Referer 转给 CDN。代理链接大约 15 分钟后失效。
- 每天检查：`node --env-file=/etc/personal-site/site.env scripts/media-selfcheck.js`。小红书检查会带上 Bearer 令牌，任一端失败时退出码非 0。

仅供保存自己或已获授权的内容。

解析成功后，结果区有两个按钮：「去白底」和「智能抠图」。图集导入图片，视频只导入封面（没有封面则不提供按钮）。点击后把同一批图片带到 `/tools/remove-background`，并自动切到所选模式处理第一张；其余留在列表里，可移除或点「全部处理并保存」。列表存在本标签页的 `sessionStorage`（键 `personal-site.image-import`），只保存本站 `/api/media/file` 路径，不保存图片字节，约 14 分钟后失效。浏览器禁止 `sessionStorage` 时，同一次页面跳转仍用内存交接。

## 智能抠图

工具页的「智能抠图」调用本站 `POST /api/matting/remove`。Node 只把请求转到 `REMBG_API_URL`（生产为 `http://127.0.0.1:7002`），再以 multipart 字段 `model` 请求该地址的 `POST /api/remove`。地址必须是回环 `http(s)`，生产启动时和每次请求都会拒绝公网地址。不跟随上游跳转，避免被带到别的主机。

rembg 由运维装在示例里的华东云主机 `192.0.2.10`（RFC 5737 文档地址，部署时改成自己的机器），不要装在跑网站的那台机器上，也不要装在别的区域。进程只监听回环，不要用 rembg 默认的 `0.0.0.0`：

```sh
rembg s --host 127.0.0.1 --port 7002
```

跑网站的机器不要直接拨 `192.0.2.10`。沿用小红书 sidecar 的方式，把那台机器的回环端口接到本机回环，例如已有的 `xhs-remote-proxy`，或一条只绑本机的 SSH 转发：

```sh
ssh -N -L 127.0.0.1:7002:127.0.0.1:7002 ops@192.0.2.10
```

然后在 `/etc/personal-site/site.env` 写 `REMBG_API_URL=http://127.0.0.1:7002`。公网 Caddy 不要反代 rembg。网站不负责安装或重启 rembg。

页面模型：`u2netp`（默认，更快）、`isnet-general-use`（质量）、`birefnet-general-lite`（精细，更慢，小内存机器可能失败）。不提供 `birefnet-portrait`。精修三选一：去色边（`dc`）、精细蒙版（`a`）、ViTMatte（`vm`）；不精修则都不传。一次只转发一张，多图在浏览器里排队。超时默认 120 秒，可用 `REMBG_TIMEOUT_MS` 调到 10–180 秒。超时、502 或内存不足时页面用中文建议改用更快的 `u2netp`，也可以改回去白底。去白底仍然只在浏览器里算，不上传。

### 手机验收

1. 用手机登录，打开「无水印下载」，解析一条多图作品。结果区应同时看到「去白底」和「智能抠图」，而不是只有一个入口。
2. 点「智能抠图」。应进入图片工具，模式已是智能抠图，图片出现在横向列表里，第一张开始处理，不用重新选文件。
3. 视频作品只带封面；没有封面时没有这两个按钮。超过 20 张时只带前 20 张，并有说明。
4. 在列表里点另一张、移除一张。再点「全部抠图并保存」，进度按「第几张 / 总数」变化；失败的那张有中文原因，其余继续。
5. 改回「去白底」后，调整强度不应再请求抠图接口。也可从相册一次选多张，列表里能预览。
6. 把上海代理关掉后再点智能抠图，应提示服务连不上或超时，并可改用去白底。iPhone 若拦截连续下载，逐张点「保存透明 PNG」。

## 运行条件

Node.js 24.14 或更新的 24.x；Linux 用于真实本机监控。内置 `node:sqlite` 在当前版本仍有实验性提示，升级前请跑测试。NAS 和远程云主机需要 Python 3.11+ 与可用的系统服务管理器。不需要前端构建、Docker、Prometheus 或 Grafana。发布目录需要 `npm ci --omit=dev`，只为 SSH 代理安装 `ssh2` 和 `ws`。

```sh
node --test tests/*.test.js
node scripts/create-credentials.js
```

凭据脚本在交互终端读取用户名和密码，密码不回显。把生成值写入本机 `.env`：

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3010
SITE_ORIGIN=http://127.0.0.1:3010
COOKIE_SECURE=false
MONITORING_MODE=mock
DATA_DIR=./data
AUTH_USERNAME=your-user
AUTH_PASSWORD_HASH=generated-scrypt-hash
AUTH_SECRET=generated-random-secret
CODEX_WEB_URL=https://your-codex.example
XHS_API_URL=http://127.0.0.1:5556
DOUYIN_API_URL=http://127.0.0.1:5555
XHS_API_TOKEN=
XHS_API_TOKEN_FILE=
DOUYIN_COOKIE=
REMBG_API_URL=http://127.0.0.1:7002
```

```sh
node --env-file=.env server/index.js
```

打开 `http://127.0.0.1:3010`。开发模拟数据会明确标注；生产设置 `NODE_ENV=production`、`MONITORING_MODE=live`、HTTPS origin，并保持 Secure Cookie。

## 云服务器部署

`deploy/personal-site.service` 提供独立用户、只读代码与内存上限。以 root 安装源代码和配置，运行服务的用户为 `personal-site`，状态目录 `/var/lib/personal-site`。

```sh
useradd --system --user-group --home-dir /var/lib/personal-site --shell /usr/sbin/nologin personal-site
install -d -m 755 /opt/personal-site/releases
install -d -m 700 /etc/personal-site
install -d -o personal-site -g personal-site -m 700 /var/lib/personal-site
```

上传源码到新 release 并创建 `/opt/personal-site/current` 链接。代码以 root 拥有，文件 644、目录 755。在该目录执行 `npm ci --omit=dev`。复制 `deploy/site.env.example` 至 `/etc/personal-site/site.env`，填写生成凭据及自己的地址，文件权限 600。

```sh
install -m 644 deploy/personal-site.service /etc/systemd/system/personal-site.service
systemctl daemon-reload
systemctl enable --now personal-site
```

检查 Node 可执行路径是否与模板中的 `/usr/local/bin/node` 一致。Caddy 模板中的 `203.0.113.10` 是文档示例地址，必须改为自己的公网 IP；证书模板使用支持 IP 短期证书的 Caddy/ACME 配置。也可使用自己的域名和常规 HTTPS 配置。80 端口转 HTTPS、443 转网站的回环端口 3010，8443 转已有 Codex 服务的回环端口 3001；未部署 Codex 时删除对应代理块。Caddy 的 `reverse_proxy` 会把 `/api/terminal/session` 的 WebSocket 升级交给 Node，不要缓冲或去掉这条路径的 `Connection` / `Upgrade`。

公网只开放需要的代理端口，不公开 3010/3001。修改站点 origin 时同步 Caddy 与 `SITE_ORIGIN`。

## NAS 主动上报

云端 `site.env` 配置一个单独生成的 `NAS_MONITOR_SECRET`，至少 32 字符；设置 `NAS_DEVICE_ID`、名称和展示地址。该密钥仅用于写入 NAS 指标，不能登录网站。

在 NAS 上把脚本安装到 `/opt/personal-site/nas-monitor.py`，建立低权限 `personal-monitor` 用户；把 `deploy/nas-monitor.env.example` 放到 `/etc/personal-site/nas-monitor.env`，权限 600。NAS 与云端的设备 ID、密钥须匹配，endpoint 必须为 HTTPS。

`NAS_MONITOR_PATHS` 使用实际数据卷挂载路径，如 `/vol1,/vol2`；脚本按文件系统设备去重，不统计 Docker overlay 副本，不遍历个人文件。安装 `deploy/nas-monitor.service` 后启动：

```sh
systemctl daemon-reload
systemctl enable --now nas-monitor
systemctl status nas-monitor --no-pager
journalctl -u nas-monitor -n 30 --no-pager
```

NAS 断网会重试，超过云端的过期阈值会在页面显示过期/离线。保持两端系统时间同步。网站服务重启后监控历史重新积累，NAS 下一次报告后恢复显示。

## 远程云主机主动上报

跑 personal-site 的阿里云主机继续用 `MONITORING_MODE=live` 和 `SERVER_*` 采样本机。华为云等远程 Linux 虚拟机不跑网站，只运行上报代理。云端按设备 ID 登记多台机器；NAS 仍是原来的单台设备，密钥和接口都不变。

`deploy/site.env.example` 用编号环境变量登记远程云主机，空的 ID 会跳过该槽，最多 8 台。示例已经写好这两台，只含名称和地址，不含密钥：

| 设备 ID | 名称 | 区域 | 公网 IP |
| --- | --- | --- | --- |
| `huawei-ap-southeast-1` | 华为云 · 东南亚 | 东南亚 · ap-southeast-1 | 198.51.100.20 |
| `huawei-cn-east-3` | 华为云 · 华东 | 华东 · cn-east-3 | 192.0.2.10 |

在阿里云的 `/etc/personal-site/site.env` 增加同样的 `REMOTE_CLOUD_*` 行。生成一把至少 32 字符的共享密钥，写入 `REMOTE_CLOUD_MONITOR_SECRET`。某一台要单独密钥时，再设置 `REMOTE_CLOUD_1_SECRET` 或 `REMOTE_CLOUD_2_SECRET`，该槽会覆盖共享密钥。上报节奏沿用 NAS 的 `NAS_REPORT_INTERVAL_MS`（默认 15 秒）、`NAS_STALE_AFTER_MS`（默认 60 秒）和 `NAS_MAX_CLOCK_SKEW_MS`（默认 120 秒）。

```sh
openssl rand -hex 32
systemctl restart personal-site
```

示例里网站的 `SITE_ORIGIN` 是 `https://203.0.113.10`（RFC 5737 文档地址，与 `deploy/site.env.example` 一致，部署时改成自己的公网地址）。每台远程虚拟机把指标 POST 到 `https://203.0.113.10/api/monitor/remote/report`。`/api/monitor/nas/report` 仍然接受同一套 HMAC，NAS 脚本不用改。请求头可用 `X-Monitor-Device-Id`、`X-Monitor-Timestamp`、`X-Monitor-Nonce`、`X-Monitor-Signature`，也可继续用原来的 `X-NAS-*`。签名串是 `deviceId.timestamp.nonce.sha256(body)`，HMAC-SHA256 的密钥是该设备的 secret。

在每台华为云虚拟机上安装代理。脚本只读 `/proc` 和根分区，不上传业务文件。把 `scripts/cloud-monitor.py` 放到 `/opt/personal-site/cloud-monitor.py`，把 `deploy/cloud-monitor.env.example` 放到 `/etc/personal-site/cloud-monitor.env`，权限 600。两台机器的 `CLOUD_DEVICE_ID`、名称、区域和 IP 按上表分开填写，密钥与阿里云 `site.env` 中该设备的密钥一致。

```sh
useradd --system --user-group --home-dir /var/lib/personal-site --shell /usr/sbin/nologin personal-monitor
install -d -m 755 /opt/personal-site
install -m 644 scripts/cloud-monitor.py /opt/personal-site/cloud-monitor.py
install -d -m 700 /etc/personal-site
install -m 600 deploy/cloud-monitor.env.example /etc/personal-site/cloud-monitor.env
install -m 644 deploy/cloud-monitor.service /etc/systemd/system/cloud-monitor.service
systemctl daemon-reload
systemctl enable --now cloud-monitor
systemctl status cloud-monitor --no-pager
journalctl -u cloud-monitor -n 30 --no-pager
```

需要 Python 3.11+。默认只统计根分区；`CLOUD_MONITOR_PATHS` 可附加其它挂载点，和根分区同一文件系统的路径会去掉。未收到上报时卡片显示等待，超过过期阈值显示离线并保留最后读数，与 NAS 相同。两端系统时间需要同步。网站进程重启后，下一次上报恢复该卡的历史。

## 概览布局、显示名称与到期日

概览页的「作品」和「监控」两块可以上下对调（并排时按左右）。桌面按住模块上的「拖动」手柄，松手后立刻写入本机 `localStorage` 键 `personal-space.dashboard-layout.v1`，和指标「波形 / 进度」一样只留在这台浏览器里，不上传服务器。手机先点「整理布局」，再用手柄或「上移 / 下移」，避免和页面滚动抢手势；长按手柄也会进入整理。「恢复默认布局」只恢复作品在上、监控在下，不清显示名称。

每张监控卡标题旁的「改名」按设备 ID 存在同一条偏好里。本机用 `SERVER_ID`（如 `cloud-01`），远程云主机用 `REMOTE_CLOUD_N_ID`，NAS 用 `NAS_DEVICE_ID`。留空就回到 `SERVER_NAME` 或 `REMOTE_CLOUD_N_NAME`。改名不会改设备 ID、IP 或采样。

到期日只读，写在服务器环境变量里。页面在卡片底部用等宽字显示上海时区的 `到期 YYYY-MM-DD`。没填或格式不对时显示「未设置」，不会编造日期。已经早于上海今天的，只把这一行标成警告色。改完后重启 `personal-site`。

```dotenv
SERVER_EXPIRES_AT=2027-03-01
NAS_DEVICE_EXPIRES_AT=2028-01-31
REMOTE_CLOUD_1_EXPIRES_AT=2026-11-30
REMOTE_CLOUD_2_EXPIRES_AT=2026-11-30T16:00:00Z
```

`YYYY-MM-DD` 按上海日历日理解。带时区的 ISO 时间先换算成上海日期再显示；没写时区的时间也按上海时间解释。

## 终端

侧边栏「终端」打开 `/terminal`。页面先处于空闲，不会自动连接。右侧列出已经写进 `site.env` 的服务器，名称、地区、IP 和在线状态与概览页的监控卡一致。点一台才发起 SSH；点另一台会先断开当前会话，状态栏显示「断开 A → 连接 B」。「断开连接」在连接中、已连接和断开过程中都可以点，并会马上关闭 WebSocket 和服务器上的 SSH 会话。离开页面或登录失效也会断开。

浏览器只收到 `id`、名称、地区、展示用主机地址和在线状态。密码、私钥和令牌只留在 Node 进程里，从环境变量或 root 可读的文件读取。允许连接的机器由 `SSH_1` 到 `SSH_8` 登记，空的 ID 会跳过。`SSH_N_ID` 与 `SERVER_ID` 或 `REMOTE_CLOUD_N_ID` 相同时，列表沿用那张监控卡的名称和地址，并继承那台机器上的 SSH 用户名、密钥和主机指纹。`SSH_N_HOST` 只决定 Node 拨号的地址，例如阿里云本机拨 `127.0.0.1`，页面仍显示 `SERVER_IP`。

在阿里云的 `/etc/personal-site/site.env` 为三台已知虚拟机增加这三个槽，值用占位说明，真实私钥不要写进仓库：

| 槽 | ID | 拨号地址 | 页面上看到的卡 |
| --- | --- | --- | --- |
| `SSH_1` | `cloud-01`（`SERVER_ID`） | `127.0.0.1` | 本机阿里云监控卡 |
| `SSH_2` | `huawei-ap-southeast-1` | 留空则使用该卡的 IP | 华为云 · 东南亚 |
| `SSH_3` | `huawei-cn-east-3` | 留空则使用该卡的 IP | 华为云 · 华东 |

```dotenv
SERVER_SSH_USERNAME=ops
SERVER_SSH_PRIVATE_KEY_FILE=/etc/personal-site/ssh/aliyun.key
SERVER_SSH_HOSTKEY=SHA256:paste-from-ssh-keygen
SSH_1_ID=cloud-01
SSH_1_HOST=127.0.0.1
SSH_1_PORT=22
REMOTE_CLOUD_1_SSH_USERNAME=ops
REMOTE_CLOUD_1_SSH_PRIVATE_KEY_FILE=/etc/personal-site/ssh/huawei-ap-southeast-1.key
REMOTE_CLOUD_1_SSH_HOSTKEY=SHA256:paste-from-ssh-keygen
SSH_2_ID=huawei-ap-southeast-1
SSH_2_PORT=22
REMOTE_CLOUD_2_SSH_USERNAME=ops
REMOTE_CLOUD_2_SSH_PRIVATE_KEY_FILE=/etc/personal-site/ssh/huawei-cn-east-3.key
REMOTE_CLOUD_2_SSH_HOSTKEY=SHA256:paste-from-ssh-keygen
SSH_3_ID=huawei-cn-east-3
SSH_3_PORT=22
```

优先给每台机器建一个低权限用户，把公钥写进它的 `authorized_keys`，再用上面的用户名和密钥文件登录。`SSH_N_USERNAME`、`SSH_N_PRIVATE_KEY_FILE` 和 `SSH_N_HOST_FINGERPRINT` 会覆盖对应机器上的 `SERVER_SSH_*` / `REMOTE_CLOUD_N_SSH_*`。密钥文件属主 `root:personal-site`，权限 640。

还没换成密钥时，继续用 `SSH_N_PASSWORD_FILE`（或机器级的 `SERVER_SSH_PASSWORD_FILE` / `REMOTE_CLOUD_N_SSH_PASSWORD_FILE`）。两边都配置时，先试私钥，服务器拒绝后再试密码。密钥文件读不到或解析失败时直接拒绝，不会悄悄退回密码。也可以临时把 PEM / 密码放进 `SSH_N_PRIVATE_KEY` / `SSH_N_PASSWORD`。

主机指纹是必填的。未配置或与服务器出示的主机密钥不一致时，终端状态栏显示「未配置主机指纹，已拒绝连接」或「主机指纹不匹配」，并且不会把密码或私钥送出去。在要连接的机器上取 SHA256 指纹：

```bash
ssh-keyscan -t ed25519,ecdsa,rsa -p 22 HOST | ssh-keygen -lf -
```

本机也可以直接看公钥文件：`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`。把输出里的 `SHA256:...` 写进 `SERVER_SSH_HOSTKEY` 或 `REMOTE_CLOUD_N_SSH_HOSTKEY`。一台机器有多把主机密钥时，用逗号或空格隔开多个指纹；协商到其中任何一把即可。`SSH_HOSTKEY_TOFU=1` 只在完全没配指纹时放行，不会记住第一次见到的密钥，配了指纹仍然必须匹配。这是迁移用的临时开关，确认指纹后删掉。

默认空闲 10 分钟断开，单会话最多 32 MB，最长 4 小时，同时最多 4 个会话。同一登录每 10 分钟最多新开 30 次终端连接。测试不拨真实虚拟机。

## 目录与扩展

```text
server/auth/                    登录、密码、会话、Cookie 与限流
server/providers/               本机、NAS、远程云主机与开发模拟数据
server/modules/catalog.js      模块清单与受保护路径
server/media/                   无水印下载：链接识别、后端调用与 CDN 代理
server/terminal/                Web SSH：允许列表、WebSocket 与服务器端登录
public/assets/components/      导航、主题、图像处理 Worker 与通用组件
public/assets/vendor/xterm/    终端模拟器（xterm.js 5.5.0，MIT）
public/assets/components/image-tools/ 像素算法、画笔与 GIF 编解码
public/assets/components/format-convert/ 格式转换：图片识别与文本、数据、Markdown
public/assets/pages/            仪表盘、作品墙、工具箱与编辑页面
public/assets/components/portfolio-data.js  作品与奖项文案
public/assets/portfolio/         奖状与占位图，仅登录后可访问
tests/                          认证、监控、终端、图片算法、GIF、格式转换与无水印下载回归测试
```

新占位工具只需在 `catalog.js` 注册；完整页面加入 `pages/` 并在 `app.js` 注册。写 API 继续保留会话、同源和 CSRF 校验，上传文件另设类型及体积边界。前端升级时增加 HTML 和 ES module 的资源版本参数。

## 隐私与许可

本仓库包含源码、测试和示例配置。远程监控示例使用 RFC 5737 文档地址：站点 origin `https://203.0.113.10`，以及两台示例云主机 `198.51.100.20`、`192.0.2.10`，并保留显示名称，方便安装上报代理。真实地址只从环境变量读取。仓库没有登录密码、监控密钥、NAS 密钥、SSH 私钥、运行数据库或部署记录。请把真实密钥和地址留在 Git 外。

界面参考 Apple 的布局和可访问性原则，未使用 Apple 标志或捆绑 SF 字体。原创短句未署名为他人名言。

MIT License，见 [LICENSE](LICENSE)。
