'use strict';

/**
 * 报告附件存储层：配置了 COS 密钥就统一写腾讯云 COS（对象 key 带 cos:// 前缀），
 * 没配置则回退到本地 data/reports（本地开发 / 历史数据兼容）。
 * DB 的 reports.file_path 存：cos://<key> 或 本地绝对路径。
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const COS_SCHEME = 'cos://';
const TEXT_EXT = ['.md', '.markdown', '.txt', '.csv', '.html', '.htm'];

let _client = null;
function cosClient() {
  if (!config.cos.enabled) return null;
  if (!_client) {
    const COS = require('cos-nodejs-sdk-v5');
    _client = new COS({
      SecretId: config.cos.secretId,
      SecretKey: config.cos.secretKey,
      SecurityToken: config.cos.token || undefined,
    });
  }
  return _client;
}

function isCos(loc) {
  return typeof loc === 'string' && loc.startsWith(COS_SCHEME);
}

const MIME = {
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function contentTypeOf(name) {
  return MIME[path.extname(String(name || '').toLowerCase())] || 'application/octet-stream';
}

/** 保存附件，返回写入后的存储标识（cos://... 或本地路径） */
async function save(userId, storedName, buffer) {
  const c = cosClient();
  if (!c) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
    const local = path.join(config.uploadDir, storedName);
    fs.writeFileSync(local, buffer);
    return local;
  }
  const key = `${config.cos.prefix}/${userId}/${storedName}`;
  await new Promise((resolve, reject) => {
    c.putObject(
      {
        Bucket: config.cos.bucket,
        Region: config.cos.region,
        Key: key,
        Body: buffer,
        ContentType: contentTypeOf(storedName),
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
  return COS_SCHEME + key;
}

/** 读取文本附件内容（用于报告原文与 AI 解析） */
async function readText(loc, ext) {
  if (!loc || !TEXT_EXT.includes(String(ext || '').toLowerCase())) return '';
  try {
    if (isCos(loc)) {
      const c = cosClient();
      const data = await new Promise((resolve, reject) => {
        c.getObject(
          { Bucket: config.cos.bucket, Region: config.cos.region, Key: loc.slice(COS_SCHEME.length) },
          (err, d) => (err ? reject(err) : resolve(d))
        );
      });
      return Buffer.isBuffer(data.Body) ? data.Body.toString('utf8') : String(data.Body || '');
    }
    return fs.readFileSync(loc, 'utf8');
  } catch (e) {
    console.warn('[storage] readText failed:', e && e.message);
    return '';
  }
}

/** 删除附件（COS 对象或本地文件），失败只记日志不中断业务 */
async function remove(loc) {
  if (!loc) return;
  try {
    if (isCos(loc)) {
      const c = cosClient();
      if (!c) return;
      await new Promise((resolve, reject) => {
        c.deleteObject(
          { Bucket: config.cos.bucket, Region: config.cos.region, Key: loc.slice(COS_SCHEME.length) },
          (err) => (err ? reject(err) : resolve())
        );
      });
    } else if (fs.existsSync(loc)) {
      fs.unlinkSync(loc);
    }
  } catch (e) {
    console.warn('[storage] remove failed:', e && e.message);
  }
}

/** 鉴权通过后发送附件给客户端 */
async function sendDownload(loc, res, fileName) {
  if (isCos(loc)) {
    const c = cosClient();
    if (!c) return res.status(404).json({ error: 'file_missing' });
    const data = await new Promise((resolve, reject) => {
      c.getObject(
        { Bucket: config.cos.bucket, Region: config.cos.region, Key: loc.slice(COS_SCHEME.length) },
        (err, d) => (err ? reject(err) : resolve(d))
      );
    });
    const name = String(fileName || 'report').replace(/["\r\n]/g, '_');
    res.setHeader('Content-Type', contentTypeOf(name));
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return res.send(data.Body);
  }
  if (loc && fs.existsSync(loc)) return res.download(loc, fileName || 'report');
  return res.status(404).json({ error: 'file_missing' });
}

module.exports = { isCos, save, readText, remove, sendDownload };
