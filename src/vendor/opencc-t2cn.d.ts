// 圧縮済みの opencc-js の型宣言。型検査はここだけを見て、圧縮コード自体は検査しない。
export function Converter(options: { from: string; to: string }): (text: string) => string;
