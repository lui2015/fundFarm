'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./src/config');
const db = require('./src/db');
const { attachUser } = require('./src/auth');
const routes = require('./src/routes');

const app = express();
const BASE = config.basePath || '';

app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  attachUser(req, res, next);
});

const publicDir = path.join(config.rootDir, 'public');

/* AI / 自动化发现用 */
const capabilities = (req, res) => {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('host') || `localhost:${config.port}`;
  const base = `${proto}://${host}${BASE}`;
  res.json({
    schema_version: 'v1',
    name_for_human: '养基场',
    name_for_model: 'fundfarm',
    description_for_model:
      '养基场是游戏化基金自选管理工具。可通过 API 查询用户的自选基金列表与详情、上传研究报告（markdown 文本或文件）、读取报告解析结果。所有接口使用 Bearer API Key 鉴权，Key 由用户在「我的 - 开发者」生成（fa_ 前缀）。',
    auth: { type: 'bearer' },
    api: { type: 'openapi', url: base + '/api/v1/capabilities' },
    base_url: base + '/api/v1',
  });
};
app.get(BASE + '/.well-known/ai-plugin.json', capabilities);
app.get(BASE + '/llms.txt', (req, res) => {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('host') || `localhost:${config.port}`;
  const base = `${proto}://${host}${BASE}`;
  res.type('text/plain; charset=utf-8').send(
    [
      '# 养基场 FundFarm',
      '',
      '> 游戏化基金自选管理工具：领养一只鸡 = 持有一只基金。',
      '',
      '## 接口（Base URL: ' + base + '/api/v1 ，鉴权：Authorization: Bearer <API_KEY>）',
      '- GET /funds：自选基金列表',
      '- GET /funds/{code}：单只基金详情（行情、净值、鸡的状态）',
      '- POST /funds/{code}/reports：上传报告（multipart: file 或 JSON: title, content, content_type, tags, parse）',
      '- GET /funds/{code}/reports：报告列表',
      '- GET /reports：报告库列表（支持 q / status / link=none|linked）',
      '- POST /reports：上传报告，fund_code 可为空表示暂不关联',
      '- PATCH /reports/{id}：修改报告或关联到某只基金',
      '- GET /reports/{id}/raw：报告原文（HTML 报告以 text/html 返回，带 CSP）',
      '- GET /reports/{id}：报告详情与 AI 解析结果',
      '- GET /notes?code=：投资心得 / 投研笔记列表',
      '- POST /notes：写一条投资心得（fund_code 可选，content 至少 10 字）',
      '- POST /chickens/{id}/interact：喂食 / 安抚（**必须附投研素材**：report_id 或 ≥10/20 字的 note）',
      '- GET /achievements：成就与解锁状态',
      '',
      '## 约定',
      '- 基金代码为 6 位数字',
      '- content_type 支持 html / markdown / text；**重点支持 html**：建议 AI 生成自包含 HTML（内联样式、无外链、无 <script>）并以 content_type=html 提交',
      '- parse=true 触发 AI 解析（生成摘要、要点、风险）',
      '- 养鸡互动需要真实投入：喂食（action=feed）必须带 report_id 或 ≥20 字的 note；安抚（action=pat）必须带 ≥10 字的 note；二者都会写入心得时间线',
      '- 打扫鸡舍前必须先照料所有饿了 / 打蔫的鸡，否则返回 409 need_care',
      '- 数据来自第三方公开接口，可能存在延迟或误差，不构成投资建议',
      '',
    ].join('\n')
  );
});

app.use(BASE + '/api/v1', routes);

app.use(
  BASE + '/',
  express.static(publicDir, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get(BASE + '/healthz', (req, res) => res.json({ ok: true, service: 'fundfarm' }));

app.get(BASE + '/*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large' });
  }
  console.error('[error]', err && err.stack ? err.stack.split('\n')[0] : err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(config.port, '127.0.0.1', () => {
  const active = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log(`养基场已启动 http://127.0.0.1:${config.port}${BASE}/  (用户数 ${active})`);
});
