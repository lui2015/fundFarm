'use strict';

require('dotenv').config();

const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || './data');

module.exports = {
  rootDir,
  dataDir,
  dbFile: path.join(dataDir, 'fundfarm.db'),
  uploadDir: path.join(dataDir, 'reports'),
  port: Number(process.env.PORT || 3290),
  basePath: (process.env.BASE_PATH || '').replace(/\/+$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  cookieName: process.env.COOKIE_NAME || 'ff_session',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 168),
  hunyuan: {
    url: process.env.HUNYUAN_API_URL || 'https://tokenhub.tencentmaas.com/v1/chat/completions',
    key: process.env.HUNYUAN_API_KEY || '',
    model: process.env.HUNYUAN_MODEL || 'hy3',
    timeoutMs: Number(process.env.HUNYUAN_TIMEOUT_MS || 45000),
  },
  rateLimit: {
    parsePerMinute: Number(process.env.RATE_LIMIT_PARSE_PER_MINUTE || 5),
    parsePerDay: Number(process.env.RATE_LIMIT_PARSE_PER_DAY || 30),
  },
  maxUploadMB: 20,
  maxAdoptions: 50,
  // COS 附件存储：配了 SecretId/Key 就走 COS，否则回退本地 data/reports
  cos: {
    secretId: process.env.COS_SECRET_ID || '',
    secretKey: process.env.COS_SECRET_KEY || '',
    token: process.env.COS_SECURITY_TOKEN || '',
    bucket: process.env.COS_BUCKET || 'lyman-1258661753',
    region: process.env.COS_REGION || 'ap-guangzhou',
    prefix: (process.env.COS_PREFIX || 'fundFarm/reports').replace(/^\/+|\/+$/g, ''),
    enabled: !!(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY),
  },
  // 默认管理员账号：首次启动时自动创建，可用环境变量覆盖；设 ADMIN_PASSWORD 为空则不创建
  admin: {
    username: process.env.ADMIN_USERNAME || 'luli',
    password: process.env.ADMIN_PASSWORD || 'luli116574',
  },
};
