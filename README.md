# 个人空间

一个轻量、自托管的个人工具箱：原生 Node.js 后端、HTML/CSS/ES modules 前端。界面使用本地托管的 [Tabler 1.6.1](https://github.com/tabler/tabler)（MIT）UI kit，提供侧边导航、作品墙、设备监控卡片、响应式工具页面和日夜主题。保留原有认证与监控接口，运行时仍无需 npm 依赖或前端构建。

Tabler 样式位于 `public/assets/vendor/tabler/tabler.min.css`，上游许可及 Bootstrap 许可保存在同目录的 `LICENSE`。图片/GIF 处理复用 [wechat-toolbox](https://github.com/Nekosan235/wechat-toolbox) 中独立的像素算法与 GIF 编解码逻辑，来源许可位于 `public/assets/components/image-tools/LICENSE`。文件只在浏览器中读取并通过 ES module Worker 处理，没有文件上传 API、外部 CDN、第三方运行时依赖或构建步骤。外观控制器同时维护 `data-theme` 与 Tabler 的 `data-bs-theme`。

## 功能

- 单用户密码登录，后端保护页面、脚本和 API；SQLite 持久会话、scrypt 密码哈希、CSRF 与登录限流。
- 作品墙：概览页 4 张主要项目卡片，另有项目页、其他练习和荣誉奖状。奖状在登录后显示。项目页留有设备三维查看位，当前不加载模型。
- 首页先显示“欢迎回来”，停留一段时间后轮换原创短句。
- 浅色、深色、跟随系统及日出日落主题；自动识别本机时区，使用明确标注的参考城市计算日出日落，可手动覆盖。
- Linux 云服务器每 5 秒真实采样 CPU、内存、根分区容量与运行时长，保留最近 60 个样本。跑网站的那台机器继续用本机采样。
- NAS 用无依赖 Python 脚本每 15 秒主动通过 HTTPS 上报；独立 HMAC、时间戳与 nonce 校验，不公开 NAS 端口。
- 其他 Linux 云主机用同一套 HMAC 上报 CPU、内存、根分区与运行时长。每台远程机器单独成卡，可与本机云主机和 NAS 同时显示。
- 多设备监控与数据卷明细，异常保留旧数据并标注时间，隐藏页面暂停请求。
- 浏览器本地图片工具：边缘连通白底移除、整图去白、擦除/还原/取色画笔、原图对比、缩放移动与透明 PNG 导出；仅静态 PNG/JPEG/WebP，不是 AI 主体识别。
- 浏览器本地 GIF 工具：逐帧去白、逐帧画笔/撤销、播放预览与透明 GIF 导出，保留帧延时和循环信息。
- 图片最大 10 MB/3200 万原始像素；GIF 最大 8 MB、60 帧、15 秒/3200 万逻辑像素，导出最大 480px 长边/20 MB。文件仅在浏览器本地处理，不上传服务器。
- 格式转换：浏览器本地处理图片、Markdown、JSON、YAML、CSV、Base64、URL 和文本，见下文。HEIC、PDF 与音视频保持不可用。
- Agent、智能抠图与视频处理保持清晰标注的待开放入口；Codex Web 外链由环境变量配置。

## 格式转换

工具箱里的「格式转换」在浏览器本地完成。转换逻辑是纯 JavaScript，由 Node 测试直接运行；页面不上传文件，不请求远程地址，也不执行系统命令。

- 图片：PNG、JPG/JPEG、WebP、GIF 互转。GIF 只保留第一帧。安全的 SVG（没有脚本、外链或嵌入对象）可以转为 PNG 或其他位图。JPG 会把透明区域铺成白色。
- 文档：Markdown 转为转义后的 HTML；TXT 和 Markdown 可以纯文本预览。
- 数据：JSON 与块式 YAML 子集互转，CSV 与 JSON 互转，Base64 编解码，URL 编解码。YAML 使用空格缩进，不支持锚点、标签和多行文本块。CSV 第一行是表头，字段保持文本。
- 文本：大小写、首尾空白、连续空格，以及 CRLF 与 LF。
- 未提供：HEIC、PDF、音频和视频。不引入原生解码库，也不调用 ffmpeg。

文本和数据上限 1 MB。图片上限 10 MB、3200 万像素；GIF 导出不超过 419 万像素。SVG 上限 512 KB。

## 运行条件

Node.js 24.14 或更新的 24.x；Linux 用于真实本机监控。内置 `node:sqlite` 在当前版本仍有实验性提示，升级前请跑测试。NAS 和远程云主机需要 Python 3.11+ 与可用的系统服务管理器。不需要 npm 安装依赖、构建、Docker、Prometheus 或 Grafana。

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

上传源码到新 release 并创建 `/opt/personal-site/current` 链接。代码以 root 拥有，文件 644、目录 755。复制 `deploy/site.env.example` 至 `/etc/personal-site/site.env`，填写生成凭据及自己的地址，文件权限 600。

```sh
install -m 644 deploy/personal-site.service /etc/systemd/system/personal-site.service
systemctl daemon-reload
systemctl enable --now personal-site
```

检查 Node 可执行路径是否与模板中的 `/usr/local/bin/node` 一致。Caddy 模板中的 `203.0.113.10` 是文档示例地址，必须改为自己的公网 IP；证书模板使用支持 IP 短期证书的 Caddy/ACME 配置。也可使用自己的域名和常规 HTTPS 配置。80 端口转 HTTPS、443 转网站的回环端口 3010，8443 转已有 Codex 服务的回环端口 3001；未部署 Codex 时删除对应代理块。

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
| `huawei-ap-southeast-1` | 华为云 · 东南亚 | 东南亚 · ap-southeast-1 | 183.87.149.115 |
| `huawei-cn-east-3` | 华为云 · 华东 | 华东 · cn-east-3 | 1.94.16.40 |

在阿里云的 `/etc/personal-site/site.env` 增加同样的 `REMOTE_CLOUD_*` 行。生成一把至少 32 字符的共享密钥，写入 `REMOTE_CLOUD_MONITOR_SECRET`。某一台要单独密钥时，再设置 `REMOTE_CLOUD_1_SECRET` 或 `REMOTE_CLOUD_2_SECRET`，该槽会覆盖共享密钥。上报节奏沿用 NAS 的 `NAS_REPORT_INTERVAL_MS`（默认 15 秒）、`NAS_STALE_AFTER_MS`（默认 60 秒）和 `NAS_MAX_CLOCK_SKEW_MS`（默认 120 秒）。

```sh
openssl rand -hex 32
systemctl restart personal-site
```

网站的 `SITE_ORIGIN` 是 `https://47.117.181.103`。每台华为云虚拟机把指标 POST 到 `https://47.117.181.103/api/monitor/remote/report`。`/api/monitor/nas/report` 仍然接受同一套 HMAC，NAS 脚本不用改。请求头可用 `X-Monitor-Device-Id`、`X-Monitor-Timestamp`、`X-Monitor-Nonce`、`X-Monitor-Signature`，也可继续用原来的 `X-NAS-*`。签名串是 `deviceId.timestamp.nonce.sha256(body)`，HMAC-SHA256 的密钥是该设备的 secret。

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

## 目录与扩展

```text
server/auth/                    登录、密码、会话、Cookie 与限流
server/providers/               本机、NAS、远程云主机与开发模拟数据
server/modules/catalog.js      模块清单与受保护路径
public/assets/components/      导航、主题、图像处理 Worker 与通用组件
public/assets/components/image-tools/ 像素算法、画笔与 GIF 编解码
public/assets/components/format-convert/ 格式转换：图片识别与文本、数据、Markdown
public/assets/pages/            仪表盘、作品墙、工具箱与编辑页面
public/assets/components/portfolio-data.js  作品与奖项文案
public/assets/portfolio/         奖状与占位图，仅登录后可访问
tests/                          认证、监控、图片算法、GIF 与格式转换回归测试
```

新占位工具只需在 `catalog.js` 注册；完整页面加入 `pages/` 并在 `app.js` 注册。写 API 继续保留会话、同源和 CSRF 校验，上传文件另设类型及体积边界。前端升级时增加 HTML 和 ES module 的资源版本参数。

## 隐私与许可

本仓库包含源码、测试和示例配置。远程监控示例写明了站点 origin `https://47.117.181.103`，以及两台华为云的公网地址和显示名称，方便安装上报代理。仓库没有登录密码、监控密钥、NAS 密钥、运行数据库或部署记录。请把真实密钥留在 Git 外。

界面参考 Apple 的布局和可访问性原则，未使用 Apple 标志或捆绑 SF 字体。原创短句未署名为他人名言。

MIT License，见 [LICENSE](LICENSE)。
