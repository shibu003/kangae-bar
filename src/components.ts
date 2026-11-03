// 節の部品の形（todo と役割は agent の CLI と作業場所が使う。表とグラフは前の保存を読むためだけに残る）
export type Table = { type: "table"; columns: string[]; rows: string[][] };
export type Chart = { type: "chart"; kind: "bar" | "line" | "pie"; labels: string[]; series: { name: string; values: number[] }[] };
export type Todo = { type: "todo"; items: { text: string; done: boolean }[] };
export type Roles = { type: "roles"; roles: { name: string; job: string }[] };
export type Component = Table | Chart | Todo | Roles;
// AI の文脈・AGENTS.md 用に、部品を文字にする
export function describe(title: string, c: Component): string {
  switch (c.type) {
    case "table":
      return [`表「${title}」`, `| ${c.columns.join(" | ")} |`, `|${c.columns.map(() => "---").join("|")}|`, ...c.rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
    case "chart":
      return [`グラフ「${title}」（${c.kind}）: ${c.labels.join(", ")}`, ...c.series.map((s) => `- ${s.name}: ${s.values.join(", ")}`)].join("\n");
    case "todo":
      return [`todo「${title}」`, ...c.items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`)].join("\n");
    case "roles":
      return [`役割「${title}」`, ...c.roles.map((r) => `- ${r.name}: ${r.job}`)].join("\n");
  }
}
