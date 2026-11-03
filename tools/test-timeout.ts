// 1 本あたりの締切 = 基準 30 秒 × load の倍率（混雑で子 process を起こす試験が実測の数十倍に伸びて偽の赤になる・w31a AC-6 は load 770 で 30 秒を越えた）
// 倍率 = ceil(load1 / (論理 CPU × 8))・下限 1・上限 10（= 300 秒。これ以上は試験が壊れているので待たない）。load が CPU×8 以下なら 30 秒のまま
import { availableParallelism, loadavg } from "node:os";
export const testTimeoutMs = (base = 30_000, load = loadavg()[0]!, cpus = availableParallelism()) => base * Math.min(10, Math.max(1, Math.ceil(load / (cpus * 8))));
