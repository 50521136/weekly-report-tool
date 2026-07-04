# 产业数字化板块周报收集工具

这是一个基于 Node.js、Express、EJS 和 SQLite 的周报收集与汇总系统，用于按“周一至周日”为一个周期收集部门成员的本周工作和下周计划，并支持管理员一键 AI 汇总生成 Word 与 Excel 周报文件。

## 主要功能

- 周报填写：所有添加的用户都可以填写“本周工作”和“下周计划”。
- 周期控制：本周期可查看和修改，历史周期仅可查看。
- 管理后台：管理员可查看本周概览、提交记录和每个人填写状态。
- 最高管理员：默认 `admin` 为最高管理员，可管理用户、系统设置、AI 服务商和 SMTP。
- 普通管理员：可填写自己的周报，也可查看本周概览和提交记录，并生成汇总表。
- AI 汇总：支持多个 OpenAI 兼容 API 服务商和多个模型按优先级轮询。
- 文件生成：按模板生成 `.xlsx` 与 `.docx` 两个文件，文件名和日期自动标记。
- SMTP 提醒：支持周报填写提醒、间隔提醒和 SMTP 测试发送。
- 登录持久化：登录状态默认保留 15 天，每次访问自动续期，服务重启后不掉登录。
- 北京时区：程序固定使用 `Asia/Shanghai`，日期周期、提醒时间和数据库时间均按北京时间处理。

## 快速启动

```bash
npm install
copy .env.example .env
npm start
```

启动后访问：

- 本机：`http://localhost:3000`
- 局域网：`http://<本机IP>:3000`

默认管理员：

- 账号：`admin`
- 密码：`admin123`

生产使用前请修改 `.env` 中的 `SESSION_SECRET` 和默认管理员密码。

## Docker 使用

项目支持两种 Docker 使用方式：本地构建镜像，或使用 GitHub Actions 云端构建后的 GHCR 镜像。

### 方式一：本地构建运行

适合在服务器或本机直接从源码构建：

```bash
copy .env.example .env
docker compose up -d --build
```

访问地址：

```text
http://localhost:3000
```

如果想换宿主机端口，例如使用 `8080`：

```bash
set HOST_PORT=8080
docker compose up -d --build
```

数据会保存在 Docker 卷 `weekly-report-data` 中，对应容器内 `/app/data`，包括 SQLite 数据库和导出文件。

### 方式二：使用云端构建镜像运行

GitHub Actions 会在推送 `main` 分支或打 `v*` 标签时自动构建镜像，并推送到 GitHub Container Registry：

```text
ghcr.io/50521136/weekly-report-tool:latest
```

服务器上只需要拉取云端镜像运行：

```bash
copy .env.example .env
docker compose -f docker-compose.cloud.yml pull
docker compose -f docker-compose.cloud.yml up -d
```

如果 GHCR 镜像是私有包，需要先登录：

```bash
docker login ghcr.io
```

### 常用 Docker 命令

```bash
# 查看运行状态
docker compose ps

# 查看日志
docker compose logs -f

# 停止服务
docker compose down

# 使用云端镜像更新到最新版
docker compose -f docker-compose.cloud.yml pull
docker compose -f docker-compose.cloud.yml up -d
```

## 配置说明

`.env.example` 提供了基础配置模板：

```env
PORT=3000
APP_TIME_ZONE=Asia/Shanghai
SESSION_SECRET=请改成随机长字符串

DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=admin123
DEFAULT_ADMIN_NAME=管理员

AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=gpt-4o-mini
```

AI 服务商、SMTP、邮箱强制绑定、提醒时间等配置也可以在后台“系统设置”中维护。

## 使用流程

1. 使用最高管理员 `admin` 登录。
2. 在“用户管理”中添加员工或管理员账号。
3. 用户首次登录后按要求修改密码，按需绑定邮箱。
4. 用户进入“我的周报”填写本周期的本周工作和下周计划。
5. 管理员进入“本周概览”查看提交状态。
6. 管理员点击 AI 生成两张表，系统会保存生成结果；已生成后可直接查看，也可重新生成。

## 数据与文件

- SQLite 数据库：`data/app.db`
- 导出文件目录：`data/exports/`
- 模板文件目录：`templates/`

`data/` 下的数据库和导出文件属于本机运行数据，默认不会提交到 GitHub。
