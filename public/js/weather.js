/**
 * 鸡舍天气动画：纯 CSS 动画 + 少量 DOM，不依赖图片 / 外部资源。
 * 由上证指数涨跌幅映射出的 key（sunny / cloudy / overcast / rain / storm）决定形态：
 *   sunny    太阳自转光芒 + 缓慢呼吸，旁边一缕小云
 *   cloudy   太阳半遮 + 两朵云不同速度漂移
 *   overcast 云层压住太阳，整体偏灰、慢慢横移
 *   rain     深色云 + 连续落雨
 *   storm    雷雨：落雨 + 闪电闪烁
 */

const KEYS = ['sunny', 'cloudy', 'overcast', 'rain', 'storm'];

export function weatherArt(key) {
  const k = KEYS.indexOf(key) >= 0 ? key : 'cloudy';
  const drops =
    k === 'rain' || k === 'storm'
      ? `<div class="wx-drops">${'<i></i>'.repeat(5)}</div>`
      : '';
  const bolt = k === 'storm' ? '<div class="wx-bolt"></div>' : '';
  return `<div class="wx wx-${k}" aria-hidden="true">
    <div class="wx-sun"></div>
    <div class="wx-cloud wx-c2"></div>
    <div class="wx-cloud wx-c3"></div>
    <div class="wx-cloud wx-c1"></div>
    ${drops}
    ${bolt}
  </div>`;
}
