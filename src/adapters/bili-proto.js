// B 站 /x/v2/subtitle/web/view 的最小 Protobuf 读取器。
function fields(bytes) {
  const out = [];
  let offset = 0;
  const varint = () => {
    let value = 0;
    let factor = 1;
    for (let i = 0; i < 10 && offset < bytes.length; i++) {
      const byte = bytes[offset++];
      value += (byte & 127) * factor;
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    throw new Error('B 站字幕元数据格式错误');
  };
  while (offset < bytes.length) {
    const key = varint();
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (!number) throw new Error('B 站字幕元数据字段错误');
    if (wire === 0) out.push({ number, value: varint() });
    else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else if (wire === 2) {
      const length = varint();
      const end = offset + length;
      if (end > bytes.length) throw new Error('B 站字幕元数据不完整');
      out.push({ number, data: bytes.subarray(offset, end) });
      offset = end;
    } else throw new Error('B 站字幕元数据类型错误');
    if (offset > bytes.length) throw new Error('B 站字幕元数据不完整');
  }
  return out;
}

export function parseWebSubtitle(bytes) {
  const data = fields(bytes).find((field) => field.number === 1)?.data;
  if (!data) return [];
  const decoder = new TextDecoder();
  return fields(data).filter((field) => field.number === 3 && field.data).flatMap((field) => {
    const item = fields(field.data);
    const get = (number) => item.find((part) => part.number === number);
    const text = (number) => get(number)?.data ? decoder.decode(get(number).data) : '';
    const lan = text(3);
    const subtitle_url = text(5);
    return lan && subtitle_url ? [{ id: get(1)?.value, lan, lan_doc: text(4), subtitle_url }] : [];
  });
}
