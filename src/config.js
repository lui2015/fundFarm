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
};
