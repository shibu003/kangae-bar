// 仮の拡張 icon（W20）: 単色の丸を 16 / 48 / 128 の PNG で extension/icons に置く。凝らない（デザインが決まったら差し替える）。使い方: bun tools/make-icons.ts
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COLOR = [0x2f, 0x6b, 0xff]; // Kangae の青（仮）
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Uint8Array) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
export function png(size: number): Buffer {
  const rows = Buffer.alloc((size * 4 + 1) * size), r = size / 2;
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r), a = Math.max(0, Math.min(1, r - d + 0.5)); // 縁を 1px だけ滑らかに
      rows.set([...COLOR, Math.round(a * 255)], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
if (import.meta.main) {
  const dir = join(import.meta.dir, "../extension/icons");
  mkdirSync(dir, { recursive: true });
  for (const s of [16, 48, 128]) writeFileSync(join(dir, `${s}.png`), png(s));
  console.log("extension/icons/{16,48,128}.png を置きました");
}
