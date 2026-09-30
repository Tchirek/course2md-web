//! Small DOM helpers shared by the panel modules.

/**
 * 浮窓には HTML 要素しか置かないので、セレクタで一つ取る（無ければ null）。型検査はこれで絞り込む。
 * @param {ParentNode|null|undefined} root
 * @param {string} selector
 */
export function one(root, selector) {
  return /** @type {HTMLElement|null} */ (root?.querySelector(selector) ?? null);
}

/**
 * セレクタに合うものをすべて配列で返す。
 * @param {ParentNode|null|undefined} root
 * @param {string} selector
 */
export function all(root, selector) {
  return /** @type {HTMLElement[]} */ ([...(root?.querySelectorAll(selector) ?? [])]);
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [className]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * @param {string} label
 * @param {(event: MouseEvent) => unknown} onClick
 * @param {string} [variant] 外观种类（c2md-button--*）
 */
export function button(label, onClick, variant) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `c2md-button${variant ? ` c2md-button--${variant}` : ''}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** @param {string|null|undefined} text */
export function plain(text) {
  const span = document.createElement('span');
  span.className = 'c2md-num';
  span.textContent = text ?? '';
  return span;
}
