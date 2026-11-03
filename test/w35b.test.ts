// W35b: agent が実際に使える口。`kangae api …` → op apiRun。操作があれば tab を開かず（browser を起こさない・card 無し）、無ければ「今の tab の道」へ返す
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiHint, apiInstalled, apiVerb, runApi, type ApiDeps } from "../src/apianything.ts";

const mk = (code: number, out: string) => {
  const seen = { asked: 0, cdp: 0, ran: [] as string[][] };
  const d: ApiDeps = {
    vendor: "/v", dataHome: "/h",
    ask: async () => { seen.asked++; return { ok: true }; },
    cdpUrl: async () => { seen.cdp++; return "http://127.0.0.1:1"; },
    run: async (cmd) => { seen.ran.push(cmd); return { code, out }; },
  };
  return { d, seen };
};

test("W35b 口の写し: list / list <site> / <site> <op> k=v / add・capture・login", () => {
  expect(apiVerb(["list"])).toEqual({ verb: "sites", args: [] });
  expect(apiVerb(["list", "canvas"])).toEqual({ verb: "ops", args: ["canvas"] });
  expect(apiVerb(["canvas", "upcoming", "days=7"])).toEqual({ verb: "call", args: ["canvas", "upcoming", "days=7"] });
  expect(apiVerb(["login", "canvas.x.edu"])).toEqual({ verb: "login", args: ["canvas.x.edu"] });
});

test("W35b 操作があれば tab を開かない: call は card 無し・headless の browser を起こさない（cdp を取りに行かない）・tier 1 に限る", async () => {
  const { d, seen } = mk(0, '{"ok":true,"tier":1,"data":[{"title":"課題"}]}');
  expect(await runApi("call", ["canvas", "upcoming", "days=7"], d)).toMatchObject({ ok: true });
  expect(seen.asked).toBe(0);
  expect(seen.cdp).toBe(0);
  expect(seen.ran[0]!.slice(-2)).toEqual(["--max-tier", "1"]);
});

test("W35b 無ければ今の tab の道: call が失敗したら『tab の道で読んで』と返す・書く旗や段の上限を緩める旗は渡させない", async () => {
  const { d, seen } = mk(1, "no operation canvas/upcoming");
  const r = await runApi("call", ["canvas", "upcoming"], d);
  expect(r).toMatchObject({ ok: false });
  expect((r as { hint: string }).hint).toContain("tab の道");
  for (const flag of ["--allow-writes", "--max-tier"]) expect(await runApi("call", ["canvas", "x", flag, "3"], d)).toMatchObject({ ok: false });
  expect(seen.ran).toHaveLength(1); // 旗つきは起こしていない
});

test("W35b 頼みの文脈の 1 行は vendor が入っている時だけ・list を見てから使う順を言う・tools に api を許す", () => {
  const home = mktmp("w35b");
  expect(apiInstalled(home)).toBe(false);
  mkdirSync(join(home, "vendor/api-anything/dist"), { recursive: true });
  writeFileSync(join(home, "vendor/api-anything/dist/cli.js"), "");
  expect(apiInstalled(home)).toBe(true);
  const h = apiHint("kangae");
  expect(h).toContain("kangae api list");
  expect(h).toContain("今の tab の道");
  const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  expect(src).toContain("apiReady ? `,Bash(${ws.bin} api:*)`");
  expect(src).toContain("if (apiReady) text = `${apiHint(ws.bin)}");
});
