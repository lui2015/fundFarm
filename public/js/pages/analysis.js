/**
 * 「分析」页：把同站的「基金分析平台」（/fundAnalysis/）整页嵌进来，不跳出养基场。
 * 两个站点同域（www.luliming.xyz），对方响应头是 X-Frame-Options: SAMEORIGIN，
 * 同源嵌套允许；同时保留「新窗口打开」作为兜底入口。
 */

const ANALYSIS_URL = 'https://www.luliming.xyz/fundAnalysis/';

export async function render() {
  return `
    <div class="card">
      <div class="card-title">📈 基金分析
        <span class="spacer"></span>
        <a class="btn ghost small" href="${ANALYSIS_URL}" target="_blank" rel="noopener">新窗口打开</a>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:8px">
        热门榜单、条件筛选与自选诊断来自「基金分析平台」，数据源天天基金，仅供参考，不构成投资建议。
      </div>
      <iframe class="embed-page" src="${ANALYSIS_URL}" title="基金分析平台" loading="lazy"
              referrerpolicy="no-referrer"></iframe>
    </div>`;
}
