//! 共用的界面零件：勾选行、分段选择、进度条、提示条。
//!
//! 弹窗与页面内面板共用同一套构造函数，所以两边的文案、禁用逻辑、
//! 无障碍属性不可能走样——它们本来就是同一份代码。

import { icon, checkGlyph } from './icons.js';

/**
 * 用户要的那几个勾选，集中声明一次。
 *
 * `needsSetup` 指向设置页的哪一段——没配好时把下一步直接告诉用户，
 * 而不是让他自己找。
 *
 * @typedef {object} DisplayToggle
 * @property {'showTimestamps'|'polish'} key 对应的设置项
 * @property {string} label
 * @property {'showTimestamps'|'polish'} [dependsOn] 要先勾选的另一项，没勾时本行禁用
 * @property {string} [needsSetup] 没配置好时「去设置」要打开的分区
 * @property {string} [unconfiguredHint] 没配置好时代替说明的一句话
 */
/** @type {DisplayToggle[]} */
export const DISPLAY_TOGGLES = [
  {
    key: 'showTimestamps',
    label: '显示讲述时刻',
  },
  {
    key: 'polish',
    label: '润色文本',
    // 未配置时换成一句能直接照做的事——面板比较窄，
    // 长句会折行并和「去设置」挤在一起
    unconfiguredHint: '使用 CLI 润色配置',
  },
];

/**
 * 一行勾选。整行可点，命中区 44px 高。
 *
 * @param {object} args
 * @param {string} args.label
 * @param {string} [args.hint]
 * @param {boolean} args.checked
 * @param {boolean} [args.disabled]
 * @param {boolean} [args.needsSetup] 未配置时在行尾给一个去设置的入口
 * @param {() => void} [args.onSetup]
 * @param {(checked:boolean) => void} args.onChange
 * @param {Node} [args.trailing] 行末に添える要素（整形の進捗リングなど）
 * @returns {HTMLLabelElement}
 */
export function checkboxRow({
  label,
  hint,
  checked,
  disabled = false,
  needsSetup = false,
  onSetup,
  onChange,
  trailing,
}) {
  const row = document.createElement('label');
  row.className = 'c2md-check';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  input.disabled = Boolean(disabled);
  input.addEventListener('change', () => onChange?.(input.checked));

  const box = document.createElement('span');
  box.className = 'c2md-check-box';
  box.appendChild(checkGlyph());

  const text = document.createElement('span');
  text.className = 'c2md-check-text';
  const strong = document.createElement('span');
  strong.className = 'c2md-check-label';
  strong.textContent = label;
  text.appendChild(strong);
  if (hint) {
    const small = document.createElement('span');
    small.className = 'c2md-check-hint';
    small.textContent = hint;
    text.appendChild(small);
  }

  row.append(input, box, text);
  if (trailing) row.appendChild(trailing);

  if (needsSetup && onSetup) {
    const setup = document.createElement('button');
    setup.type = 'button';
    setup.className = 'c2md-button c2md-button--quiet c2md-check-setup';
    setup.textContent = '去设置';
    // label 里嵌按钮：阻止冒泡，否则点设置会顺带切换勾选
    setup.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSetup();
    });
    row.appendChild(setup);
  }

  return row;
}

/**
 * 两选一的分段选择。
 * @param {object} args
 * @param {{value:string,label:string,title?:string}[]} args.options
 * @param {string} args.value
 * @param {(value:string) => void} args.onChange
 * @returns {HTMLDivElement}
 */
export function segmented({ options, value, onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'c2md-segmented';
  wrap.setAttribute('role', 'group');

  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.label;
    button.setAttribute('aria-pressed', String(option.value === value));
    if (option.title) button.title = option.title;
    button.addEventListener('click', () => {
      if (option.value === value) return;
      onChange?.(option.value);
    });
    wrap.appendChild(button);
  }
  return wrap;
}

/**
 * 进度。`ratio` 为 null 时跑不确定态（滑动，不是转圈）。
 * @param {{ratio?:number|null, label?:string}} args
 */
export function progress({ ratio = null, label } = {}) {
  const wrap = document.createElement('div');
  if (label) {
    const caption = document.createElement('div');
    caption.className = 'c2md-meta c2md-progress-label';
    caption.textContent = label;
    wrap.appendChild(caption);
  }
  const track = document.createElement('div');
  track.className = `c2md-progress${ratio === null ? ' c2md-progress--indeterminate' : ''}`;
  const bar = document.createElement('div');
  bar.className = 'c2md-progress-bar';
  if (ratio !== null) bar.style.width = `${Math.round(ratio * 100)}%`;
  track.appendChild(bar);
  wrap.appendChild(track);
  return wrap;
}

/**
 * 提示条。`tone` 只有 warn / error 两档，普通说明用 default。
 * @param {{title?:string, body?:string, tone?:'default'|'warn'|'error', actions?:HTMLElement[]}} args
 */
export function note({ title, body, tone = 'default', actions = [] } = {}) {
  const el = document.createElement('div');
  el.className = `c2md-note${tone === 'default' ? '' : ` c2md-note--${tone}`}`;
  if (title) {
    const t = document.createElement('div');
    t.className = 'c2md-note-title';
    t.textContent = title;
    el.appendChild(t);
  }
  if (body) {
    const b = document.createElement('div');
    b.textContent = body;
    el.appendChild(b);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'c2md-note-actions';
    row.append(...actions);
    el.appendChild(row);
  }
  return el;
}

/**
 * 图标按钮。
 * @param {object} args
 * @param {Parameters<typeof icon>[0]} args.iconName
 * @param {string} args.label 无障碍名与 tooltip
 * @param {() => void} args.onClick
 */
export function iconButton({ iconName, label, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'c2md-icon-button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(icon(iconName));
  button.addEventListener('click', onClick);
  return button;
}

/**
 * 把主题设置落到 DOM 上。
 *
 * `.c2md-scope` 的深色有两套选择器：跟随系统的媒体查询，和 `[data-theme]` 属性。
 * 只写设置而不设属性，就会出现「选了深色但界面是浅色」这种不一致——
 * 面板里已经做了（applyDisplayMode），弹窗与设置页也得跟上。
 *
 * @param {{theme?: string}|null|undefined} settings
 * @param {HTMLElement} [root]
 */
export function applyTheme(settings, root = document.body) {
  if (!root) return;
  root.dataset.theme = settings?.theme ?? 'auto';
}

/**
 * 渲染那几行勾选，并把依赖关系接好。
 *
 * @param {object} args
 * @param {import('../core/settings.js').Settings} args.settings
 * @param {(patch:object) => void} args.onChange 用户改动后回调（只需处理持久化）
 * @param {() => void} [args.onSetup] 点「去设置」时打开设置页
 * @param {boolean} [args.showPolishLevel] 整形の強さの選択を出す
 * @param {boolean} [args.showPolishEngine] 显示润色方式（本机/自备）选择
 * @param {boolean} [args.polishLevelWhenChecked] 只在勾选润色时显示润色强度/方式
 * @param {{running?:boolean, done:number, total:number}|null} [args.polishProgress] 整形の進捗（あれば整形の行末に進捗リングを描く）
 * @returns {DocumentFragment}
 */
export function displayToggleRows({ settings, onChange, onSetup, showPolishLevel = false, showPolishEngine = false, polishLevelWhenChecked = false, polishProgress = null }) {
  const frag = document.createDocumentFragment();

  for (const toggle of DISPLAY_TOGGLES) {
    const disabled = Boolean(toggle.dependsOn && !settings[toggle.dependsOn]);
    const needsSetup = Boolean(toggle.needsSetup && !isConfigured(toggle.needsSetup, settings));
    frag.appendChild(
      checkboxRow({
        label: toggle.label,
        hint: disabled
          ? `需要先勾选「${labelOf(toggle.dependsOn)}」`
          : needsSetup && toggle.unconfiguredHint
            ? toggle.unconfiguredHint
            : '',
        checked: Boolean(settings[toggle.key]),
        disabled,
        needsSetup,
        onSetup,
        onChange: (checked) => onChange?.({ [toggle.key]: checked }),
        trailing: toggle.key === 'polish' && polishProgress?.running
          ? progressRing(polishProgress.done, polishProgress.total, '润色') : undefined,
      }),
    );
    if (toggle.key === 'showTimestamps') {
      const row = document.createElement('div');
      row.className = 'c2md-image-choice';
      const label = document.createElement('span');
      label.textContent = '显示图片';
      row.append(label, segmented({
        options: [
          { value: 'none', label: '无' }, { value: 'few', label: '少' },
          { value: 'default', label: '默认' }, { value: 'many', label: '多' },
        ],
        value: settings.imageLevel,
        onChange: (imageLevel) => onChange?.({ imageLevel }),
      }));
      frag.appendChild(row);
    }
    if (toggle.key === 'polish' && showPolishLevel && (!polishLevelWhenChecked || settings.polish)) {
      const row = document.createElement('div');
      row.className = 'c2md-image-choice';
      const label = document.createElement('span');
      label.textContent = '润色强度';
      row.append(label, segmented({
        options: [{ value: 'light', label: '轻度' }, { value: 'standard', label: '标准' }, { value: 'deep', label: '深度' }],
        value: settings.polishLevel,
        onChange: (polishLevel) => onChange?.({ polishLevel }),
      }));
      frag.appendChild(row);
    }
  }
  if (showPolishEngine && (!polishLevelWhenChecked || settings.polish)) {
    const row = document.createElement('div');
    row.className = 'c2md-image-choice';
    const label = document.createElement('span');
    label.textContent = '润色方式';
    row.append(label, polishEngineRow(settings, onChange));
    frag.appendChild(row);
  }
  return frag;
}

/**
 * 润色方式选择：CLI 配置或自备 API（兼容旧的 auto 语义）。
 * @param {import('../core/settings.js').Settings} settings
 * @param {(patch:{polishEngine: string}) => void} onChange
 */
export function polishEngineRow(settings, onChange) {
  return segmented({
    options: [
      { value: 'local', label: 'CLI 配置', title: '沿用 course2md 已配置的润色服务' },
      { value: 'custom', label: '自备 API', title: '使用你自己配置的 OpenAI 兼容 LLM' },
    ],
    value: settings.polishEngine === 'auto'
      ? (settings.llm?.baseUrl && settings.llm?.model ? 'custom' : 'local')
      : settings.polishEngine,
    onChange: (polishEngine) => onChange?.({ polishEngine }),
  });
}

/**
 * 有已知总量时才画圆环；每完成一块推进一次。
 * @param {number} done
 * @param {number} total
 * @param {string} label
 */
export function progressRing(done, total, label) {
  const ring = document.createElement('span');
  ring.className = 'c2md-ring';
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  ring.style.setProperty('--progress', `${ratio * 100}%`);
  ring.title = total > 0 ? `${label} ${done}/${total}` : `正在准备${label}`;
  ring.setAttribute('role', 'progressbar');
  ring.setAttribute('aria-label', label);
  ring.setAttribute('aria-valuemin', '0');
  if (total > 0) {
    ring.setAttribute('aria-valuemax', String(total));
    ring.setAttribute('aria-valuenow', String(done));
  }
  return ring;
}

/** @param {string|undefined} key */
function labelOf(key) {
  return DISPLAY_TOGGLES.find((t) => t.key === key)?.label ?? key;
}

/**
 * @param {string} section 设置页分区
 * @param {import('../core/settings.js').Settings} settings
 */
function isConfigured(section, settings) {
  if (section === 'llm') {
    return Boolean(settings.llm?.baseUrl && settings.llm?.model);
  }
  return true;
}
