// 回数ではなく実の時間（Date.now）の締切で待つ。混んだ機械（8GB・load 数百）では 1 周が遅くなるので、「N 回」の待ちは総時間が伸び縮みして先に諦める。
// probe が真（null/undefined/false 以外）を返したらその値、締切を越えたら undefined。probe は必ず 1 回は呼ぶ（締切が 0 でも）。
export async function pollUntil<T>(probe: () => T | Promise<T>, ms: number, stepMs: number): Promise<Exclude<T, null | undefined | false> | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v as Exclude<T, null | undefined | false>;
    const left = end - Date.now();
    if (left <= 0) return undefined;
    await Bun.sleep(Math.min(stepMs, left)); // 最後の sleep は締切で切り、締切の時点でもう 1 回測る
  }
}
