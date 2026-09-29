//! 会話中キャッシュ（chrome.storage.session）：戻る・進むで同じ動画に来たとき、取り直さずに復元する。

/** キャッシュの有効期間：動画が変わっているかもしれず、古いノートは誤解を招く。 */
const MAX_AGE_MS = 3600_000;

/** 同じサイト・同じ URL（パスとクエリ）で一つ。 */
export function sessionKey(adapterId) {
  return `cache:${adapterId}:${location.pathname}${location.search}`;
}

/**
 * 保存する。生成した拡張の版を記録し、コードが更新されたら古いロジックの産物は無効にする。
 * 保存できない（容量超過など）ときは黙って諦め、次回取り直すだけにする。
 */
export async function saveSession(key, entry) {
  try {
    await chrome.storage.session?.set({
      [key]: { ...entry, version: chrome.runtime.getManifest().version, savedAt: Date.now() },
    });
  } catch {
    /* session 領域が使えないか容量超過 */
  }
}

/** @returns {Promise<any>} 有効な項目。期限切れ・版違い・無しなら null */
export async function loadSession(key) {
  try {
    const stored = await chrome.storage.session?.get(key);
    const entry = /** @type {any} */ (stored?.[key]);
    if (!entry) return null;
    if (Date.now() - (entry.savedAt ?? 0) > MAX_AGE_MS) return null;
    // 版が違えば、旧コードの産物（直したはずの不具合を含むかもしれない）は使わない
    if (entry.version !== chrome.runtime.getManifest().version) return null;
    return entry;
  } catch {
    return null;
  }
}
