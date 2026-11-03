// 試験の一時 folder は全部ここを通る（tmpleak-3）。名前は ks-<name>-XXXXXX で、tools/clean-tmp.ts は「ks- で始まり 6 字で終わる」1 つの規則で掃除する
// ＝新しい試験が名前を許可表に足し忘れても、掃除の対象外にならない（足し忘れ自体が起きない）。test/tmpleak1.test.ts が「ここを通らない mkdtemp が 0」を見る
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const mktmp = (name: string, base: string = tmpdir()): string => mkdtempSync(join(base, `ks-${name.replace(/[^A-Za-z0-9_-]/g, "") || "t"}-`));
