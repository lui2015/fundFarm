'use strict';

/**
 * 报告解析：优先调用大模型（混元），未配置或失败时退化为本地启发式摘要。
 * 解析结果强制标注 AI 生成，仅供参考。
 */

const config = require('./config');
const { RateLimiter, nowISO } = require('./util');

const limiter = new RateLimiter();

const SYSTEM_PROMPT = `你是基金研究助手，只做事实陈述与数据解读，不得给出买入/卖出等投资建议。
用户会提供一份基金相关的报告文本，请输出严格的 JSON（不要输出 markdown 代码块以外的任何内容），字段如下：
{
  "report_title": "报告标题",
  "report_date": "YYYY-MM-DD 或 null",
  "summary": "不超过 200 字的中文摘要",
  "key_points": ["要点1", "要点2", "要点3"],
  "risks": ["风险1", "风险2", "风险3"],
  "sentiment": "positive|neutral|negative",
  "rating": null,
  "confidence": 0.0-1.0 的数字
}`;

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch (e) {
    return null;
  }
}

async function callHunyuan(content, fundName) {
  const { url, key, model, timeoutMs } = config.hunyuan;
  if (!key) throw new Error('no_api_key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `基金名称：${fundName || '未知'}\n报告正文（可能已截断）：\n${content.slice(0, 24000)}`,
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(text);
    if (!parsed) throw new Error('bad_json');
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

const RISK_WORDS = ['风险', '回撤', '波动', '不确定', '下滑', '下行', '集中', '高位', '估值偏高', '赎回', '亏损', '警惕'];
const POSITIVE_WORDS = ['增长', '回升', '跑赢', '改善', '超预期', '提升', '回暖', '扩张'];

function heuristic(content, fundName) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return {
      summary: '（未能提取到文本内容，仅保存文件）',
      key_points: [],
      risks: [],
      sentiment: 'neutral',
      confidence: 0.2,
    };
  }
  const sentences = text.split(/(?<=[。！？；\n])/).filter((s) => s.length > 8);
  const scored = sentences.map((s) => {
    let score = 0;
    if (/\d/.test(s)) score += 2;
    if (/%/.test(s)) score += 2;
    if (/重仓|持仓|净值|收益率|规模|份额|仓位/.test(s)) score += 2;
    return { s: s.trim(), score };
  });
  scored.sort((a, b) => b.score - a.score);
  const keyPoints = scored.slice(0, 4).map((x) => x.s.slice(0, 120));

  const risks = sentences
    .filter((s) => RISK_WORDS.some((w) => s.includes(w)))
    .slice(0, 3)
    .map((s) => s.trim().slice(0, 120));

  const pos = sentences.filter((s) => POSITIVE_WORDS.some((w) => s.includes(w))).length;
  const neg = sentences.filter((s) => RISK_WORDS.some((w) => s.includes(w))).length;
  const sentiment = pos > neg * 1.5 ? 'positive' : neg > pos * 1.5 ? 'negative' : 'neutral';

  return {
    summary: text.slice(0, 220) + (text.length > 220 ? '…' : ''),
    key_points: keyPoints,
    risks,
    sentiment,
    confidence: 0.45,
  };
}

/**
 * 解析报告文本
 * @returns {Promise<{summary,key_points,risks,sentiment,rating,confidence,model}>}
 */
async function parseReport(content, fundName, userId) {
  const canParse =
    config.hunyuan.key &&
    limiter.hit('m:' + userId, config.rateLimit.parsePerMinute, 60000) &&
    limiter.hit('d:' + userId, config.rateLimit.parsePerDay, 86400000);

  if (canParse) {
    try {
      const r = await callHunyuan(content, fundName);
      return {
        summary: r.summary || '',
        key_points: Array.isArray(r.key_points) ? r.key_points.slice(0, 8) : [],
        risks: Array.isArray(r.risks) ? r.risks.slice(0, 8) : [],
        sentiment: ['positive', 'neutral', 'negative'].includes(r.sentiment) ? r.sentiment : 'neutral',
        rating: r.rating ?? null,
        confidence: typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : 0.6,
        model: config.hunyuan.model,
        createdAt: nowISO(),
        ai: true,
      };
    } catch (err) {
      /* 失败则走本地摘要 */
    }
  }
  const h = heuristic(content, fundName);
  return { ...h, rating: null, model: 'heuristic', createdAt: nowISO(), ai: false };
}

module.exports = { parseReport, heuristic };
