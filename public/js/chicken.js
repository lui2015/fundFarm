/**
 * 鸡的形象：纯 SVG 生成，随品种配色、等级体型、状态装饰变化。
 * 无外部素材依赖，低端设备可关闭动画（prefers-reduced-motion 由 CSS 统一处理）。
 */

export function chickenSVG(c, opts = {}) {
  const size = opts.size || 96;
  const event = opts.event || null;
  const body0 = (c && c.colors && c.colors.body) || '#C89B62';
  const accent = (c && c.colors && c.colors.accent) || '#8B6E4E';
  const lv = (c && c.level) || 1;
  const gold = lv >= 5;
  const body = gold ? '#F3C13A' : body0;
  const scale = [0.66, 0.78, 0.9, 1.0, 1.06][Math.min(Math.max(lv - 1, 0), 4)];
  const thin = c && c.thin;
  const sick = !!(c && c.sick);
  const state = (c && c.state) || 'good';
  const dark = '#3B3226';
  const combColor = gold ? '#FFC53D' : '#E6503A';

  const eye = (() => {
    if (state === 'bad' || sick) {
      return `<path d="M74 40 q4 4 8 0" stroke="${dark}" stroke-width="2" fill="none" stroke-linecap="round"/>
              <path d="M88 40 q4 4 8 0" stroke="${dark}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    }
    const r = state === 'great' ? 3.4 : 2.8;
    return `<circle cx="78" cy="41" r="${r}" fill="${dark}"/><circle cx="79.4" cy="39.8" r="1" fill="#fff"/>
            <circle cx="92" cy="41" r="${r}" fill="${dark}"/><circle cx="93.4" cy="39.8" r="1" fill="#fff"/>`;
  })();

  const comb = `<g fill="${combColor}">
      <circle cx="80" cy="26" r="4.2"/>
      <circle cx="86" cy="23" r="5"/>
      <circle cx="92" cy="26" r="4.2"/>
    </g>`;

  const halo = gold
    ? `<ellipse cx="86" cy="18" rx="20" ry="6" fill="none" stroke="#FFC53D" stroke-width="2.4" opacity="0.9"/>`
    : '';

  const eggSvg = event === 'golden_egg'
    ? `<g class="ck-egg"><ellipse cx="34" cy="94" rx="9" ry="11" fill="#FFC53D" stroke="#E0A800" stroke-width="1.5"/>
        <path d="M28 92 q6 4 12 0" stroke="#fff" stroke-width="1.6" fill="none" opacity=".8"/></g>`
    : event === 'egg'
    ? `<g class="ck-egg"><ellipse cx="34" cy="95" rx="8" ry="10" fill="#FFFDF6" stroke="#E6DCC4" stroke-width="1.5"/></g>`
    : '';

  const featherSvg = event === 'drop3' || event === 'drop1'
    ? `<g class="ck-drop" stroke="${accent}" stroke-width="2" fill="none" stroke-linecap="round">
        <path d="M22 34 q6 8 0 16"/><path d="M14 44 q6 8 0 14"/><path d="M30 26 q5 7 0 13"/>
       </g>`
    : '';

  const rainSvg = sick
    ? `<g class="ck-cloud">
        <path d="M60 20 q-6 0 -6 -7 q0 -8 8 -8 q3 -5 9 -3 q8 1 8 9 q6 1 4 8 z" fill="#B0BEC5" transform="translate(6,10)"/>
        <g stroke="#90A4AE" stroke-width="2.4" stroke-linecap="round">
          <line x1="66" y1="30" x2="64" y2="40"/><line x1="76" y1="32" x2="74" y2="43"/><line x1="86" y1="30" x2="84" y2="41"/>
        </g>
       </g>`
    : '';

  const hungrySvg = opts.showHungry && c && c.hungry
    ? `<g><ellipse cx="24" cy="20" rx="15" ry="11" fill="#fff" stroke="#E6DCC4" stroke-width="1.5"/>
        <path d="M18 28 l-3 6 l7 -3" fill="#fff" stroke="#E6DCC4" stroke-width="1.5"/>
        <text x="24" y="24" text-anchor="middle" font-size="11" fill="#8A8172">饿</text></g>`
    : '';

  const bodyRx = thin ? 20 : 27;
  const bodyRy = thin ? 20 : 25;

  return `<svg viewBox="0 0 120 110" width="${size}" height="${size * (110 / 120)}" role="img"
      aria-label="${(c && c.breedName) || '鸡'} Lv.${lv}">
    <g transform="translate(60,72) scale(${scale}) translate(-60,-72)">
      <!-- 地面草 -->
      <g stroke="#8CC63F" stroke-width="3" stroke-linecap="round" opacity=".7">
        <path d="M22 100 l0 -8"/><path d="M31 100 l-3 -7"/><path d="M100 100 l0 -8"/><path d="M108 100 l3 -7"/>
      </g>
      <!-- 腿 -->
      <g stroke="${accent}" stroke-width="3.4" stroke-linecap="round">
        <path d="M52 88 l0 12"/><path d="M68 88 l0 12"/>
        <path d="M52 100 l-6 0"/><path d="M52 100 l6 0"/><path d="M68 100 l-6 0"/><path d="M68 100 l6 0"/>
      </g>
      <!-- 尾巴 -->
      <path d="M36 60 q-16 -6 -18 -22 q14 2 22 12 z" fill="${accent}"/>
      <!-- 身体 -->
      <ellipse cx="60" cy="70" rx="${bodyRx}" ry="${bodyRy}" fill="${body}"/>
      <!-- 翅膀 -->
      <g class="ck-wing" style="transform-origin:60px 70px">
        <ellipse cx="58" cy="72" rx="13" ry="10" fill="${accent}" opacity=".85"/>
      </g>
      <!-- 头 -->
      <circle cx="86" cy="42" r="16" fill="${body}"/>
      ${comb}
      <!-- 喙 -->
      <path d="M100 44 l12 4 l-12 5 z" fill="#FFC53D"/>
      <!-- 肉垂 -->
      <path d="M96 54 q4 6 -2 9 q-5 -3 -1 -9 z" fill="${combColor}" opacity=".9"/>
      ${eye}
      ${halo}
      ${rainSvg}
      ${featherSvg}
    </g>
    ${eggSvg}
    ${hungrySvg}
  </svg>`;
}

export function eventEmoji(type) {
  return {
    golden_egg: '[金蛋]',
    egg: '[蛋]',
    drop1: '[羽毛]',
    drop3: '[羽毛]',
    sick: '[躲雨]',
    idle: '[散步]',
    adopt: '[领养]',
    release: '[放归]',
    report: '[报告]',
    achievement: '[成就]',
    task: '[任务]',
    care: '[照料]',
    weather: '[天气]',
    system: '',
  }[type] || '';
}
