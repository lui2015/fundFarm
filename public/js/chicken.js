/**
 * 鸡的形象：纯 SVG 生成。
 * 品种决定基础色系，基金代码派生出的 look 决定花色（图案 / 配饰 / 鸡冠 / 尾巴 / 体型），
 * 所以同一个品种下的不同基金也是不同的鸡，且换设备不会变样。
 * 等级影响体型与金鸡光环，状态影响表情与装饰；无外部素材依赖。
 */

let clipSeq = 0;

export function chickenSVG(c, opts = {}) {
  const size = opts.size || 96;
  const event = opts.event || null;
  const look = (c && c.look) || {};
  const body0 = look.body || (c && c.colors && c.colors.body) || '#C89B62';
  const accent = look.accent || (c && c.colors && c.colors.accent) || '#8B6E4E';
  const accent2 = look.accent2 || accent;
  const lv = (c && c.level) || 1;
  const gold = lv >= 5;
  const body = gold ? '#F3C13A' : body0;
  const scale = [0.66, 0.78, 0.9, 1.0, 1.06][Math.min(Math.max(lv - 1, 0), 4)];
  const thin = c && c.thin;
  const sick = !!(c && c.sick);
  const state = (c && c.state) || 'good';
  const dark = '#3B3226';
  const combColor = gold ? '#FFC53D' : look.combColor || '#E6503A';

  const variant = typeof look.variant === 'number' ? look.variant : 0;
  const pattern = look.pattern || 'solid';
  const accessory = look.accessory || 'none';
  const combType = look.comb || 'triple';
  const tailType = look.tail || 'fan';

  /* 体型：同一品种下也有胖瘦高矮差异 */
  const shape = [
    { rx: 27, ry: 25, headR: 16, headX: 86, leg: 12 },
    { rx: 24.5, ry: 27, headR: 15, headX: 85, leg: 10 },
    { rx: 29, ry: 24, headR: 17, headX: 87, leg: 12 },
    { rx: 26, ry: 26, headR: 16, headX: 88, leg: 11 },
  ][variant] || { rx: 27, ry: 25, headR: 16, headX: 86, leg: 12 };

  /* 收益体型：决定神情与动作（暴瘦无神、匀称正常、肥嘟嘟得意） */
  const buildKey = (c && c.build && c.build.key) || 'normal';
  const weakBuild = buildKey === 'veryThin' || buildKey === 'thin';
  const plumpBuild = buildKey === 'plump' || buildKey === 'fat' || buildKey === 'obese';
  const starving = buildKey === 'veryThin';

  const eye = (() => {
    const cx1 = shape.headX - 8;
    const cx2 = shape.headX + 6;
    /* 生病 / 心情差优先：两条下垂的弧线 */
    if (sick || state === 'bad') {
      return `<g class="ck-eye"><path d="M${cx1 - 4} 40 q4 4 8 0" stroke="${dark}" stroke-width="2" fill="none" stroke-linecap="round"/></g>
              <g class="ck-eye"><path d="M${cx2 - 4} 40 q4 4 8 0" stroke="${dark}" stroke-width="2" fill="none" stroke-linecap="round"/></g>`;
    }
    /* 肥：满足的眯眼 ^ ^ */
    if (plumpBuild) {
      return `<g class="ck-eye"><path d="M${cx1 - 4.4} 42.4 q4.4 -5 8.8 0" stroke="${dark}" stroke-width="2.2" fill="none" stroke-linecap="round"/></g>
              <g class="ck-eye"><path d="M${cx2 - 4.4} 42.4 q4.4 -5 8.8 0" stroke="${dark}" stroke-width="2.2" fill="none" stroke-linecap="round"/></g>`;
    }
    /* 瘦：半睁、上眼皮压下来，瞳孔没光 */
    if (weakBuild) {
      return `<g class="ck-eye">
                <circle cx="${cx1}" cy="43.8" r="2.5" fill="${dark}" opacity=".82"/>
                <path d="M${cx1 - 5} 39.4 q5 -2.6 10 0" stroke="${dark}" stroke-width="1.8" fill="none" stroke-linecap="round"/>
              </g>
              <g class="ck-eye">
                <circle cx="${cx2}" cy="43.8" r="2.5" fill="${dark}" opacity=".82"/>
                <path d="M${cx2 - 5} 39.4 q5 -2.6 10 0" stroke="${dark}" stroke-width="1.8" fill="none" stroke-linecap="round"/>
              </g>`;
    }
    /* 匀称：圆眼 + 高光，靠 CSS 眨眼 */
    const r = state === 'great' ? 3.4 : 2.8;
    return `<g class="ck-eye"><circle cx="${cx1}" cy="41" r="${r}" fill="${dark}"/><circle cx="${cx1 + 1.4}" cy="39.8" r="1" fill="#fff"/></g>
            <g class="ck-eye"><circle cx="${cx2}" cy="41" r="${r}" fill="${dark}"/><circle cx="${cx2 + 1.4}" cy="39.8" r="1" fill="#fff"/></g>`;
  })();

  /* 肥鸡脸上两坨腮红，暴瘦鸡头顶一滴虚汗 */
  const blush = plumpBuild
    ? `<g fill="#F08A8A" opacity=".35">
        <ellipse cx="${shape.headX - 13}" cy="50" rx="4.6" ry="2.8"/>
        <ellipse cx="${shape.headX + 8}" cy="50" rx="4.6" ry="2.8"/>
      </g>`
    : '';
  const sweat = starving
    ? `<g class="ck-sweat"><path d="M${shape.headX + 19} 20 q4 5.6 0 9 q-4 -3.4 0 -9" fill="#8FD3F4" opacity=".95"/>
        <circle cx="${shape.headX + 17.8}" cy="24.6" r="1.1" fill="#fff" opacity=".75"/></g>`
    : '';
  const sparkle = buildKey === 'obese'
    ? `<g class="ck-sparkle" fill="#FFD54A" opacity=".9">
        <path d="M${shape.headX + 22} 22 l1.6 4.2 l4.2 1.6 l-4.2 1.6 l-1.6 4.2 l-1.6 -4.2 l-4.2 -1.6 l4.2 -1.6 z"/>
      </g>`
    : '';

  const comb = (() => {
    const cx = shape.headX;
    if (combType === 'single') {
      return `<g fill="${combColor}"><ellipse cx="${cx - 1}" cy="26" rx="7" ry="9"/></g>`;
    }
    if (combType === 'crest') {
      return `<g fill="${combColor}">
        <circle cx="${cx - 8}" cy="27" r="4.6"/><circle cx="${cx - 2}" cy="23" r="5.6"/><circle cx="${cx + 5}" cy="25" r="4.4"/>
      </g>`;
    }
    if (combType === 'fluff') {
      return `<g fill="${combColor}" opacity=".95">
        <circle cx="${cx - 9}" cy="26" r="3.4"/><circle cx="${cx - 4}" cy="22.5" r="3.8"/>
        <circle cx="${cx + 2}" cy="22" r="3.6"/><circle cx="${cx + 7}" cy="25" r="3.2"/>
      </g>`;
    }
    return `<g fill="${combColor}">
      <circle cx="${cx - 6}" cy="26" r="4.2"/><circle cx="${cx}" cy="23" r="5"/><circle cx="${cx + 6}" cy="26" r="4.2"/>
    </g>`;
  })();

  const halo = gold
    ? `<ellipse cx="${shape.headX}" cy="18" rx="20" ry="6" fill="none" stroke="#FFC53D" stroke-width="2.4" opacity="0.9"/>`
    : '';

  const tail = (() => {
    if (tailType === 'curl') {
      return `<path d="M38 62 q-14 -4 -16 -20 q6 12 16 8" fill="none" stroke="${accent}" stroke-width="5.5" stroke-linecap="round"/>
              <path d="M34 66 q-12 0 -16 -10" fill="none" stroke="${accent}" stroke-width="4.5" stroke-linecap="round" opacity=".8"/>`;
    }
    if (tailType === 'long') {
      return `<path d="M38 62 q-18 -6 -24 -26 q10 6 15 14 z" fill="${accent}"/>
              <path d="M40 70 q-20 0 -30 -16 q12 2 20 8 z" fill="${accent}" opacity=".85"/>`;
    }
    if (tailType === 'short') {
      return `<path d="M38 64 q-12 -4 -13 -16 q11 4 16 10 z" fill="${accent}"/>`;
    }
    return `<path d="M36 60 q-16 -6 -18 -22 q14 2 22 12 z" fill="${accent}"/>`;
  })();

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

  /* 收益体型：亏损越瘦、盈利越壮（build 由后端按收益率区间给出） */
  const BUILD_SCALE = {
    veryThin: [0.7, 0.86],
    thin: [0.84, 0.92],
    slim: [0.92, 0.97],
    normal: [1, 1],
    plump: [1.06, 1.04],
    fat: [1.12, 1.08],
    obese: [1.18, 1.12],
  };
  const bs = BUILD_SCALE[buildKey] || BUILD_SCALE.normal;
  const bodyRx = (thin ? 20 : shape.rx) * bs[0];
  const bodyRy = (thin ? 20 : shape.ry) * bs[1];
  const clipId = `ckbody${++clipSeq}`;

  /* 花色图案：全部裁剪在身体里，保证不溢出轮廓 */
  const patternSvg = (() => {
    if (pattern === 'spots') {
      return `<g clip-path="url(#${clipId})" fill="${accent2}" opacity=".55">
        <circle cx="52" cy="60" r="6.5"/><circle cx="68" cy="74" r="5.5"/><circle cx="46" cy="78" r="4.5"/><circle cx="72" cy="58" r="4"/>
      </g>`;
    }
    if (pattern === 'stripes') {
      return `<g clip-path="url(#${clipId})" stroke="${accent2}" stroke-width="5" opacity=".45" stroke-linecap="round">
        <line x1="40" y1="88" x2="56" y2="52"/><line x1="54" y1="92" x2="70" y2="56"/><line x1="68" y1="94" x2="84" y2="60"/>
      </g>`;
    }
    if (pattern === 'patch') {
      return `<g clip-path="url(#${clipId})" fill="${accent2}" opacity=".5">
        <path d="M38 52 q6 -14 20 -10 q6 10 -4 22 q-14 6 -16 -12 z"/>
      </g>`;
    }
    if (pattern === 'belly') {
      return `<g clip-path="url(#${clipId})">
        <ellipse cx="62" cy="82" rx="17" ry="12" fill="#FFFDF6" opacity=".92"/>
        <ellipse cx="62" cy="82" rx="17" ry="12" fill="none" stroke="${accent2}" stroke-width="1.6" opacity=".55"/>
      </g>`;
    }
    if (pattern === 'speckle') {
      return `<g clip-path="url(#${clipId})" fill="${accent2}" opacity=".6">
        <circle cx="48" cy="60" r="2.2"/><circle cx="56" cy="72" r="1.8"/><circle cx="64" cy="62" r="2"/>
        <circle cx="70" cy="78" r="2.2"/><circle cx="44" cy="74" r="1.6"/><circle cx="74" cy="66" r="1.6"/>
        <circle cx="60" cy="84" r="1.8"/><circle cx="52" cy="86" r="1.5"/>
      </g>`;
    }
    return '';
  })();

  /* 配饰 */
  const accessorySvg = (() => {
    const nx = shape.headX;
    if (accessory === 'scarf') {
      return `<g>
        <path d="M${nx - 18} 54 q18 11 34 1 l0 6 q-16 10 -34 -1 z" fill="#E6503A" opacity=".92"/>
        <path d="M${nx + 10} 60 l6 10 l-7 1 l-4 -9 z" fill="#E6503A" opacity=".92"/>
      </g>`;
    }
    if (accessory === 'glasses') {
      return `<g fill="none" stroke="${dark}" stroke-width="1.6" opacity=".85">
        <circle cx="${nx - 8}" cy="41" r="6.4"/><circle cx="${nx + 6}" cy="41" r="6.4"/>
        <line x1="${nx - 1.6}" y1="41" x2="${nx + 0}" y2="41"/>
      </g>`;
    }
    if (accessory === 'bow') {
      return `<g fill="#E6498A" opacity=".9">
        <path d="M${nx - 16} 30 l-8 -6 l0 12 z"/><path d="M${nx - 16} 30 l8 -6 l0 12 z"/>
        <circle cx="${nx - 16}" cy="30" r="2.4"/>
      </g>`;
    }
    if (accessory === 'bell') {
      return `<g>
        <path d="M${nx - 12} 56 q12 8 24 0" fill="none" stroke="#B08A3E" stroke-width="2"/>
        <circle cx="${nx}" cy="61" r="4" fill="#FFC53D" stroke="#E0A800" stroke-width="1.2"/>
      </g>`;
    }
    if (accessory === 'hat') {
      return `<g>
        <path d="M${nx - 13} 22 q6 -18 19 -8 q6 4 6 8 z" fill="#4C7EA8"/>
        <ellipse cx="${nx + 2}" cy="22" rx="14" ry="3.4" fill="#3E6A8E"/>
      </g>`;
    }
    return '';
  })();

  return `<svg viewBox="0 0 120 110" width="${size}" height="${size * (110 / 120)}" role="img"
      aria-label="${(c && c.breedName) || '鸡'}${look.name ? '·' + look.name : ''} Lv.${lv}">
    <defs><clipPath id="${clipId}"><ellipse cx="60" cy="70" rx="${bodyRx}" ry="${bodyRy}"/></clipPath></defs>
    <g transform="translate(60,72) scale(${scale}) translate(-60,-72)">
      <!-- 地面草（不参与鸡的动作） -->
      <g stroke="#8CC63F" stroke-width="3" stroke-linecap="round" opacity=".7">
        <path d="M22 100 l0 -8"/><path d="M31 100 l-3 -7"/><path d="M100 100 l0 -8"/><path d="M108 100 l3 -7"/>
      </g>
    <g class="ck-anim ck-${buildKey}" style="transform-origin:60px 98px">
      <!-- 腿 -->
      <g stroke="${accent}" stroke-width="3.4" stroke-linecap="round">
        <path d="M52 88 l0 ${shape.leg}"/><path d="M68 88 l0 ${shape.leg}"/>
        <path d="M52 ${88 + shape.leg} l-6 0"/><path d="M52 ${88 + shape.leg} l6 0"/>
        <path d="M68 ${88 + shape.leg} l-6 0"/><path d="M68 ${88 + shape.leg} l6 0"/>
      </g>
      <!-- 尾巴 -->
      ${tail}
      <!-- 身体 -->
      <ellipse cx="60" cy="70" rx="${bodyRx}" ry="${bodyRy}" fill="${body}"/>
      ${patternSvg}
      <!-- 翅膀 -->
      <g class="ck-wing" style="transform-origin:60px 70px">
        <ellipse cx="58" cy="72" rx="13" ry="10" fill="${accent}" opacity=".85"/>
      </g>
      <!-- 头 -->
      <circle cx="${shape.headX}" cy="42" r="${shape.headR}" fill="${body}"/>
      ${comb}
      <!-- 喙 -->
      <path d="M${shape.headX + 14} 44 l12 4 l-12 5 z" fill="#FFC53D"/>
      <!-- 肉垂 -->
      <path d="M${shape.headX + 10} 54 q4 6 -2 9 q-5 -3 -1 -9 z" fill="${combColor}" opacity=".9"/>
      ${blush}
      ${eye}
      ${accessorySvg}
      ${halo}
      ${rainSvg}
      ${featherSvg}
      ${sweat}
      ${sparkle}
    </g>
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

/**
 * 收益体型 → 鸡舍卡片背景氛围。
 * 亏得越多越阴冷（飘雨），赚得越多越暖（阳光/金光/彩带），
 * 让人不看数字、只扫一眼背景就能感觉到这只鸡养得好不好。
 */
const BG_BY_BUILD = {
  veryThin: ['cold', 'rain'],
  thin: ['drizzle', 'rain'],
  slim: ['breeze', ''],
  normal: ['grass', ''],
  plump: ['sunny', 'spark'],
  fat: ['golden', 'spark'],
  obese: ['party', 'confetti'],
};

/** 背景 class：bg-cold / bg-drizzle / … / bg-party */
export function yardBgClass(build) {
  const hit = BG_BY_BUILD[build && build.key];
  return `bg-${hit ? hit[0] : 'grass'}`;
}

/** 背景粒子层（雨 / 光点 / 彩带），无粒子时返回空串 */
export function yardBgFx(build) {
  const hit = BG_BY_BUILD[build && build.key];
  const fx = hit ? hit[1] : '';
  return fx ? `<i class="bg-fx fx-${fx}" aria-hidden="true"></i>` : '';
}
