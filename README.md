# 养基场 FundFarm

把基金自选管理做成「养鸡游戏」：领养一只鸡 = 持有一只基金，涨跌变成产蛋与掉毛，让枯燥的持仓管理变得有趣。

需求文档见 [`docs/PRD-养基场.md`](./docs/PRD-养基场.md)，本仓库为 MVP（V1.0）实现。

## 技术栈

- 后端：Node.js + Express 4 + SQLite（better-sqlite3）
- 前端：原生 ES Module SPA（hash 路由）+ CSS 变量主题，无构建步骤
- 鸡的形象：SVG 动态生成（随品种、等级、状态变化），无外部素材依赖
- 行情：服务端代理第三方公开基金接口，带缓存、降级与失败兜底

## 快速开始

```bash
npm install
cp .env.example .env        # 修改 SESSION_SECRET 等
npm start                   # 默认 http://127.0.0.1:3290
```

首次打开页面可用「游客模式」直接进入，也可注册账号（数据会保存在服务端 SQLite）。

可选：在 `.env` 中配置 `HUNYUAN_API_KEY`，即可使用大模型解析上传的研究报告；未配置时自动退化为本地摘要，功能不受影响。

## 目录结构

```
server.js              服务入口（静态资源 + API 挂载 + SPA 兜底）
src/
  config.js            环境变量配置
  db.js                SQLite 建表与成就/任务种子数据
  auth.js              注册登录、会话 Cookie、API Key（fa_ 前缀）
  quote.js             基金行情代理（估值/历史净值/搜索/大盘指数）
  ai.js                报告解析（混元 hy3，失败退化为本地摘要）
  routes.js            全部 REST 接口
  engine/
    chicken.js         养鸡引擎：涨跌事件映射、状态衰减、互动、等级
    achievements.js    成就检测
    tasks.js           每日任务
    yard.js            鸡舍聚合（行情 + 盈亏 + 事件 + 天气）
public/
  index.html           SPA 骨架
  css/style.css        主题与响应式布局（移动端底部 Tab / PC 侧栏）
  js/                  路由、页面、SVG 鸡、工具函数
data/                  SQLite 库与上传的报告（已 gitignore）
```

## 搜索

领养弹窗的基金搜索带**自动联想补全**（`public/js/autocomplete.js`）：

- 输入代码、名称或拼音首字母（如 `005827` / `易方达蓝筹` / `yfdlc`）即触发防抖联想（250ms，请求带序号防竞态）
- 支持 ↑↓ 选择、回车确认、Esc 关闭；鼠标点击同样可选
- 选中后自动填充基金代码与昵称，联想数据来自 `/api/v1/search`（服务端 10 分钟缓存）

## 核心玩法规则

| 当日涨跌幅 | 事件 | 状态变化 |
| --- | --- | --- |
| ≥ +2% | 下金蛋 | 心情 +12，成长 +8 |
| +0.5% ~ +2% | 下蛋 | 心情 +8，成长 +5 |
| -0.1% ~ +0.5% | 散步 | 心情 +2，成长 +3 |
| -1.5% ~ -0.1% | 掉 1 根毛 | 心情 -6，成长 +2 |
| -3% ~ -1.5% | 掉 3 根毛 | 心情 -12，健康 -3 |
| ≤ -3% | 躲雨 | 心情 -20，健康 -8 |

- 连续上涨 ≥3 天：成长值 ×1.5；连续下跌 ≥3 天：进入情绪低谷，抚摸后恢复成长。
- 每 24 小时未互动：饱食 -10 / 心情 -5 / 健康 -2（有下限，鸡不会「死亡」）。
- 鸡舍天气由上证指数涨跌映射（晴 / 多云 / 阴 / 雨），影响全体心情。
- **等级只与陪伴时长和照料投入有关，与收益率无关**（产品价值观，勿改）。

## 主要接口

统一前缀 `/api/v1`，支持 Cookie 会话或 `Authorization: Bearer <API_KEY>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（含 AI 配置与数据源成功率） |
| POST | `/auth/register` `/auth/login` `/auth/guest` `/auth/logout` | 账号 |
| GET | `/yard` | 鸡舍总览：天气、盈亏、鸡群、事件、任务、提醒 |
| POST | `/yard/clean` `/yard/music` `/yard/feed-all` | 全场互动 |
| GET/POST | `/funds` | 自选列表 / 领养 |
| GET/PATCH/DELETE | `/funds/{code}` | 基金详情 / 编辑 / 放归 |
| POST | `/chickens/{id}/interact` | 喂食 / 抚摸 |
| GET/POST | `/groups` | 分组 |
| GET | `/funds/{code}/reports` POST | 报告列表 / 上传（multipart 或 JSON） |
| GET/DELETE | `/reports/{id}` | 报告详情（含 AI 解析）/ 删除 |
| GET | `/ai-prompt?code=` | 面向 AI 的调用提示词（页面可一键复制） |
| GET | `/achievements` `/tasks` `/diary` `/breeds` | 成就 / 任务 / 日记 / 图鉴 |
| GET | `/me/checkin` `/me/settings` `/me/keys` `/me/export` | 签到 / 设置 / API Key / 导出 |

机器可发现：`/.well-known/ai-plugin.json`、`/llms.txt`、`/api/v1/capabilities`。

AI 上传报告示例：

```bash
curl -X POST http://127.0.0.1:3290/api/v1/funds/005827/reports \
  -H "Authorization: Bearer fa_xxx" -H "Content-Type: application/json" \
  -d '{"title":"2026Q2季报解读","tags":["AI生成"],"content":"...","parse":true}'
```

## 部署要点

- 单端口服务，PM2：`pm2 start ecosystem.config.cjs && pm2 save`
- 子路径部署：设置 `.env` 的 `BASE_PATH=/fundFarm`，Nginx 用 `proxy_pass http://127.0.0.1:3290;`（**不带尾斜杠**，保留前缀），前端全部走相对路径
- 根路径部署：`BASE_PATH` 留空即可
- 数据安全：`data/`（SQLite 库 + 上传报告）不在版本库中，部署时只覆盖源码，切勿整体覆盖运行目录

## 数据来源与免责声明

净值、估值、基金档案来自第三方公开接口（天天基金、腾讯行情），可能存在延迟或误差。
服务端统一代理并做缓存与降级，第三方不可用时展示最近一次成功数据并标注。
本工具仅供个人学习研究，不提供任何买入/卖出建议，不构成投资建议。
