// loadmap.json → 区分ごとの表（CPU は 1 標本目を除く 29 区間の平均と最大）
const d = JSON.parse(await Bun.file(process.argv[2] ?? "docs/verify/loadmap/loadmap.json").text())
const rows = d.rows, cats = Object.keys(rows[0].agg)
const f = (x: number) => x.toFixed(1)
console.log(`標本 ${rows.length} 本・${rows[0].t} 〜 ${rows.at(-1).t}・論理 CPU ${d.ncpu}（CPU% は 100=1 core）\n`)
console.log("| 区分 | CPU 平均 | CPU 最大 | RSS 平均 MB | RSS 最大 MB | 本数 平均 |\n|---|---|---|---|---|---|")
for (const c of cats) {
  const cpu = rows.slice(1).map((r: any) => r.agg[c].cpu), rss = rows.map((r: any) => r.agg[c].rss), n = rows.map((r: any) => r.agg[c].n)
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  console.log(`| ${c} | ${f(avg(cpu))} | ${f(Math.max(...cpu))} | ${f(avg(rss))} | ${f(Math.max(...rss))} | ${Math.round(avg(n))} |`)
}
const L = rows.map((r: any) => r.load)
console.log(`\nload 1分: 始 ${f(L[0])} / 終 ${f(L.at(-1))} / 最小 ${f(Math.min(...L))} / 最大 ${f(Math.max(...L))}`)
console.log(`swap: 始 ${rows[0].swap}\n      終 ${rows.at(-1).swap}`)
console.log("load 推移: " + L.map(f).join(" "))
