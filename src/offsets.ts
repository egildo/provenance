// The one place string indices become byte offsets (design principle: One address space).

/** Converts string indices into `text` to UTF-8 byte offsets, in one pass. */
export function byteOffsets(text: string, indices: readonly number[]): number[] {
  const order = indices.map((_, k) => k).sort((a, b) => indices[a] - indices[b]);
  const result = new Array<number>(indices.length);
  let i = 0;
  let bytes = 0;
  for (const k of order) {
    const target = indices[k];
    while (i < target) {
      const code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
      i += 1;
    }
    result[k] = bytes;
  }
  return result;
}
