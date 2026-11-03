import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const sign = (env: Record<string, string>) =>
  Bun.spawnSync(["sh", join(root, "scripts/sign-bar.sh"), "/x/Kangae Bar.app", "--dry"], { env: { PATH: process.env.PATH!, ...env } });
const ID = { KANGAE_SIGN_ID: "Developer ID Application: Test (ABC)", KANGAE_NOTARY_PROFILE: "prof" };

test("環境変数が有る時: 内側（常駐→読み取り.app）から署名し、最後に外側→公証→staple→spctl の順に command を並べる", () => {
  const r = sign(ID);
  expect(r.exitCode).toBe(0);
  const lines = r.stdout.toString().trim().split("\n");
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const [k, rd, app, verify, submit, staple, spctl] = ([/sign .*bin\/kangae$/, /bin\/Kangae Bar 読み取り\.app$/, /--sign .*Kangae Bar\.app$/, /--verify/, /notarytool submit .*--wait/, /stapler staple/, /spctl -a -vv/].map(at)) as [number, number, number, number, number, number, number];
  expect([k, rd, app, verify, submit, staple, spctl].every((i) => i >= 0)).toBe(true);
  expect(k < rd && rd < app && app < verify && verify < submit && submit < staple && staple < spctl).toBe(true);
  expect(lines.filter((l) => l.includes("codesign --force")).every((l) => l.includes("--options runtime --timestamp"))).toBe(true);
  expect(lines[0]).toContain("entitlements-bun.plist");
});

test("環境変数が無い/片方だけの時は何もせず exit 3（adhoc のまま）", () => {
  for (const env of [{}, { KANGAE_SIGN_ID: "x" }, { KANGAE_NOTARY_PROFILE: "p" }] as Record<string, string>[]) {
    const r = sign(env);
    expect(r.exitCode).toBe(3);
    expect(r.stdout.toString()).toBe("");
  }
});

test("dist-bar.sh: 署名の段は両方の環境変数が有る時だけ・無い時は今までの adhoc の 1 行", () => {
  const s = readFileSync(join(root, "scripts/dist-bar.sh"), "utf8");
  expect(s).toContain('if [ -n "${KANGAE_SIGN_ID:-}" ] && [ -n "${KANGAE_NOTARY_PROFILE:-}" ]; then sh scripts/sign-bar.sh "$A"; else codesign --force --sign - "$A" >/dev/null 2>&1; fi');
});
