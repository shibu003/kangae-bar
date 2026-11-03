// W35: api-anything の入口。add / capture は承認 card を通らなければ process を起こさない・call は card 無し（W35c: login は無い＝cookie を写さない）
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cardOf, runApi, type ApiDeps } from "../src/apianything.ts";

const mk = (answer: { ok: true } | { ok: false; hint: string }) => {
  const seen = { asked: [] as string[], ran: [] as string[][], env: [] as Record<string, string>[] };
  const d: ApiDeps = {
    vendor: "/v/api-anything", dataHome: "/h/api-anything",
    ask: async (c) => { seen.asked.push(c.label); return answer; },
    cdpUrl: async () => "http://127.0.0.1:5555",
    run: async (cmd, env) => { seen.ran.push(cmd); seen.env.push(env); return { code: 0, out: "{\"ok\":true}" }; },
  };
  return { d, seen };
};

test("W35 add / capture は、人が断ると process を起こさない（2 つとも）", async () => {
  for (const verb of ["add", "capture"]) {
    const { d, seen } = mk({ ok: false, hint: "人が断りました" });
    expect(await runApi(verb, ["canvas.example.edu"], d)).toEqual({ ok: false, hint: "人が断りました" });
    expect(seen.asked).toHaveLength(1);
    expect(seen.ran).toHaveLength(0);
  }
});

test("W35 許されたら起こす: vendor の cli・API_ANYTHING_HOME は kangae の下・製品の headless の URL を CDP として渡す", async () => {
  const { d, seen } = mk({ ok: true });
  expect(await runApi("add", ["canvas.example.edu"], d)).toMatchObject({ ok: true });
  expect(seen.ran[0]).toEqual(["node", "/v/api-anything/dist/cli.js", "add", "canvas.example.edu"]);
  expect(seen.env[0]).toEqual({ API_ANYTHING_HOME: "/h/api-anything", API_ANYTHING_CDP_URL: "http://127.0.0.1:5555" });
});

test("W35 call（読むだけ）は card 無しで起こす・知らない verb は起こさない", async () => {
  const { d, seen } = mk({ ok: false, hint: "呼ばれない" });
  expect(await runApi("call", ["hacker-news", "search", "query=x"], d)).toMatchObject({ ok: true });
  expect(seen.asked).toHaveLength(0);
  expect(await runApi("mcp", [], d)).toMatchObject({ ok: false }); // 常駐する MCP server は起こさせない
  expect(await runApi("../x", [], d)).toMatchObject({ ok: false });
  expect(seen.ran).toHaveLength(1);
});

test("W35 capture / add の card は画面に出さないと書く", () => {
  expect(cardOf("capture", "x.com").note).toContain("あなたの画面には出しません");
  expect(cardOf("add", "x.com").note).toContain("あなたの画面には出しません");
});

test("W35 常駐の apiRun は agent の頼みの中からだけ・承認は leases.confirmApi を通る（直に runApi へ繋がない）", () => {
  const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  const at = src.indexOf('case "apiRun"');
  const body = src.slice(at, at + 1400);
  expect(body).toContain("^s:");
  expect(body).toContain("leases.confirmApi(owner, d)");
  expect(body).toContain("r.status !== \"running\"");
});
