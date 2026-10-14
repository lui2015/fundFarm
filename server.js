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
      '- POST /funds/{code}/reports：上传报告（multipart: file 或 JSON: content, title, tags, parse）',
      '- GET /funds/{code}/reports：报告列表',
      '- GET /reports/{id}：报告详情与 AI 解析结果',
      '- GET /achievements：成就与解锁状态',
      '',
      '## 约定',
      '- 基金代码为 6 位数字',
      '- 报告内容 Markdown 正文放在 content 字段，parse=true 触发 AI 解析',
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
