import type { LanguageModel } from "ai";
import { LlmError, buildPrompt, limitFor, parseReply, type Mouth } from "./llm.ts";

// 鍵の口。出典は ai-sdk.dev の公式 doc（Apache-2.0）。鍵は macOS の keychain（Bun.secrets）だけに置く。
// baseURL・headers は受けず、各社の公式の endpoint に固定する。こちらは何も中継しない。
export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type Provider = (typeof PROVIDERS)[number];
const SERVICE = "kangae-sora";
type Stored = { key: string; model: string };

// SDK は鍵の口が実際に呼ばれる時だけ読む（startup-1: 静的 import だと host / CLI の起動のたびに 190〜350ms かかった。使わない人・引数だけで終わる起動は読まない）
const makeModel = async (p: Provider, s: Stored): Promise<LanguageModel> =>
  p === "anthropic" ? (await import("@ai-sdk/anthropic")).createAnthropic({ apiKey: s.key })(s.model)
  : p === "openai" ? (await import("@ai-sdk/openai")).createOpenAI({ apiKey: s.key })(s.model)
  : (await import("@ai-sdk/google")).createGoogleGenerativeAI({ apiKey: s.key })(s.model);

const version = (id: string) => (id.match(/\d+(?:\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [version(a), version(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

// モデル名は固定せず、鍵を入れた時に各社の一覧から新しい小型を選ぶ（名前は cutoff の後に変わるため）
async function chooseModel(p: Provider, key: string): Promise<string> {
  const get = async (url: string, headers: Record<string, string>) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (r.status === 401 || r.status === 403) throw new LlmError("failed", "この鍵は通りませんでした。入れ直してください");
    if (!r.ok) throw new LlmError("failed", `${p} の一覧を取れませんでした（${r.status}）`);
    return (await r.json()) as any;
  };
  let ids: string[];
  if (p === "anthropic") {
    const j = await get("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": key, "anthropic-version": "2023-06-01" });
    ids = j.data.map((m: any) => m.id).filter((id: string) => /haiku/.test(id)); // 新しい順で返る
    if (ids[0]) return ids[0];
  } else if (p === "openai") {
    const j = await get("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` });
    ids = j.data.map((m: any) => m.id).filter((id: string) => /^gpt-[\d.]+-mini$/.test(id)).sort(newer);
  } else {
    const j = await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": key });
    ids = j.models
      .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m: any) => String(m.name).replace(/^models\//, ""))
      .filter((id: string) => /^gemini-[\d.]+-flash$/.test(id))
      .sort(newer);
  }
  if (!ids[0]) throw new LlmError("failed", `${p} で使える小さいモデルが見つかりませんでした`);
  return ids[0];
}

function mouthOf(p: Provider, s: Stored): Mouth {
  return {
    name: `${p}（鍵）`,
    async call(path, outline, task) {
      try {
        const { generateText } = await import("ai");
        const { text } = await generateText({
          model: await makeModel(p, s),
          prompt: buildPrompt(path, outline, task),
          abortSignal: AbortSignal.timeout(limitFor(task)),
          maxRetries: 0,
        });
        return parseReply(text);
      } catch (e: any) {
        if (e instanceof LlmError) throw e;
        if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new LlmError("slow", `${p} の返事が ${limitFor(task) / 1000} 秒以内に来ませんでした。少し待ってからもう一度`);
        if (e?.statusCode === 401 || e?.statusCode === 403) throw new LlmError("failed", "鍵が通りませんでした。入れ直してください");
        throw new LlmError("failed", `${p} が失敗しました（${String(e?.message ?? e).slice(0, 120)}）`);
      }
    },
  };
}

export async function loadKeyMouth(): Promise<Mouth | null> {
  for (const p of PROVIDERS) {
    const raw = await Bun.secrets.get({ service: SERVICE, name: p }).catch(() => null);
    if (!raw) continue;
    try {
      return mouthOf(p, JSON.parse(raw) as Stored);
    } catch {}
  }
  return null;
}

// 入れた直後に 1 回だけ試す。通った時だけ keychain に置く
export async function setKey(p: Provider, key: string): Promise<void> {
  key = key.trim();
  if (!PROVIDERS.includes(p) || key.length < 8) throw new LlmError("failed", "鍵が短すぎます。もう一度貼ってください");
  const s: Stored = { key, model: await chooseModel(p, key) };
  await mouthOf(p, s).call(["こんにちは"], undefined, { component: "挨拶の todo を 1 項目だけ", want: "todo" });
  await Bun.secrets.set({ service: SERVICE, name: p, value: JSON.stringify(s) });
}
