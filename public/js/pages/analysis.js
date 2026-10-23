/**
 * 「分析」页：把同站的「基金分析平台」（/fundAnalysis/）整页嵌进来，不跳出养基场。
 * 两个站点同域（www.luliming.xyz），对方响应头是 X-Frame-Options: SAMEORIGIN，
 * 同源嵌套允许；「新窗口打开」做成悬浮按钮，不占版面。
 */

const ANALYSIS_URL = 'https://www.luliming.xyz/fundAnalysis/';

export async function render() {
  return `
    <div class="embed-page-wrap">
      <a class="embed-float" href="${ANALYSIS_URL}" target="_blank" rel="noopener"
         title="在新窗口打开基金分析平台">↗ 新窗口</a>
      <iframe class="embed-page" src="${ANALYSIS_URL}" title="基金分析平台" loading="lazy"
              referrerpolicy="no-referrer"></iframe>
    </div>`;
}
