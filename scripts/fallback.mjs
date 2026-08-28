import { readFileSync, writeFileSync } from "node:fs";

const raw = JSON.parse(readFileSync("data/raw.json", "utf8"));

/* Claude が動かなかったときの代替。
   1マスは画面から手で決められないので、ここで必ず1件は出す。
   日付のいちばん近いタスクをそのまま置く。 */
const tasks = (raw.tasks || []).map(t => t.n).slice(0, 8);
const mas = tasks[0] || "";

writeFileSync("data/events.json", JSON.stringify({
  generated: raw.generated,
  today: raw.today,
  tomorrow: raw.tomorrow,
  events: raw.events,
  tasks,
  mas,
  why: mas ? "日付がいちばん近いから" : "",
}, null, 2));

console.log(`fallback: 予定${(raw.events || []).length}件 / タスク${tasks.length}件 / 1マス「${mas || "なし"}」`);
