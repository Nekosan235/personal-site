# 个人空间

一个轻量、自托管的个人工具箱：原生 Node.js 后端、HTML/CSS/ES modules 前端，系统字体、简洁留白、日夜主题和随页面滚动变化的背景。

## 功能

- 单用户密码登录，后端保护页面、脚本和 API；SQLite 持久会话、scrypt 密码哈希、CSRF 与登录限流。
- 首页先显示“欢迎回来”，停留一段时间后轮换原创短句。
- 浅色、深色、跟随系统及日出日落主题；自动识别本机时区，使用明确标注的参考城市计算日出日落，可手动覆盖。
- Linux 云服务器每 5 秒真实采样 CPU、内存、根分区容量与运行时长，保留最近 60 个样本。
- NAS 用无依赖 Python 脚本每 15 秒主动通过 HTTPS 上报；独立 HMAC、时间戳与 nonce 校验，不公开 NAS 端口。
- 多设备监控与数据卷明细，异常保留旧数据并标注时间，隐藏页面暂停请求。
- 工具箱、Agent、抠图与文件转换预留页面；Codex Web 外链由环境变量配置。

## 运行条件

Node.js 24.14 或更新的 24.x；Linux 用于真实本机监控。内置 `node:sqlite` 在当前版本仍有实验性提示，升级前请跑测试。NAS 需要 Python 3.11+ 与可用的系统服务管理器。不需要 npm 安装依赖、构建、Docker、Prometheus 或 Grafana。

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

## 目录与扩展

```text
server/auth/              登录、密码、会话、Cookie 与限流
server/providers/         本机、NAS 与开发模拟数据
server/modules/catalog.js 模块清单与受保护路径
public/assets/components/ 导航、指标、轮询、主题与公共组件
public/assets/pages/      首页与各模块页面
scripts/                  凭据生成与 NAS 采集
deploy/                   服务、代理与环境变量模板
tests/                    认证、监控与主题测试
```

新占位工具只需在 `catalog.js` 注册；完整页面加入 `pages/` 并在 `app.js` 注册。写 API 继续保留会话、同源和 CSRF 校验，上传文件另设类型及体积边界。前端升级时增加 HTML 和 ES module 的资源版本参数。

## 隐私与许可

本仓库仅包含源码、测试和示例配置，没有作者的实际服务器地址、NAS 地址、登录凭据、运行数据库或部署记录。请把自己的环境配置与运行数据保留在 Git 外。

界面参考 Apple 的布局和可访问性原则，未使用 Apple 标志或捆绑 SF 字体。原创短句未署名为他人名言。

MIT License，见 [LICENSE](LICENSE)。
