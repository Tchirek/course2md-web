//! Small DOM helpers shared by the panel modules.

/** 浮窓には HTML 要素しか置かないので、セレクタで一つ取る（無ければ null）。型検査はこれで絞り込む。 */
export function one(root, selector) {
  return /** @type {HTMLElement|null} */ (root?.querySelector(selector) ?? null);
}

/** セレクタに合うものをすべて配列で返す。 */
export function all(root, selector) {
  return /** @type {HTMLElement[]} */ ([...(root?.querySelectorAll(selector) ?? [])]);
}

export function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function button(label, onClick, variant) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `c2md-button${variant ? ` c2md-button--${variant}` : ''}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function plain(text) {
  const span = document.createElement('span');
  span.className = 'c2md-num';
  span.textContent = text ?? '';
  return span;
}
