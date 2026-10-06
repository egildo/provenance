// The one place string indices become byte offsets (design principle: One address space).

/**
 * Converts string indices into `text` to UTF-8 byte offsets, in one pass. An index it cannot
 * convert is a handler bug, and throws a `RangeError`: not an integer, negative, past the end of
 * `text` (`text.length` itself is the end, and valid), or between the halves of a surrogate pair.
 */
export function byteOffsets(text: string, indices: readonly number[]): number[] {
  for (const index of indices) {
    if (!Number.isInteger(index)) throw new RangeError(`index ${index} is not an integer`);
    if (index < 0) throw new RangeError(`index ${index} is negative`);
    if (index > text.length) throw new RangeError(`index ${index} is past the end of the text (length ${text.length})`);
  }
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
      else if (code >= 0xd800 && code < 0xdc00 && isLow(text.charCodeAt(i + 1))) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
      i += 1;
    }
    if (i > target) throw new RangeError(`index ${target} is inside a surrogate pair`);
    result[k] = bytes;
  }
  return result;
}

/** A low surrogate; `NaN` (past the end) is not. */
const isLow = (code: number) => code >= 0xdc00 && code < 0xe000;
