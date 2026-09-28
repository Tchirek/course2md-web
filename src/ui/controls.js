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
 */
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
    unconfiguredHint: '将启用本机润色',
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
 * @param {string} args.iconName
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
 * @param {object} settings
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
 * @param {object} args.settings
 * @param {(patch:object) => void} args.onChange 用户改动后回调（只需处理持久化）
 * @param {() => void} [args.onSetup] 点「去设置」时打开设置页
 * @returns {DocumentFragment}
 */
export function displayToggleRows({ settings, onChange, onSetup, showPolishLevel = false }) {
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
    if (toggle.key === 'polish' && showPolishLevel) {
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
  if (showPolishLevel) frag.appendChild(checkboxRow({
    label: '切换视频自动生成', checked: settings.autoRun,
    onChange: (autoRun) => onChange?.({ autoRun }),
  }));
  return frag;
}

function labelOf(key) {
  return DISPLAY_TOGGLES.find((t) => t.key === key)?.label ?? key;
}

function isConfigured(section, settings) {
  if (section === 'llm') {
    return Boolean(settings.llm?.baseUrl && settings.llm?.model);
  }
  return true;
}
