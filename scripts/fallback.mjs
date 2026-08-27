import { readFileSync, writeFileSync } from "node:fs";

const raw = JSON.parse(readFileSync("data/raw.json", "utf8"));

/* Claude が動かなかったときの代替。
   タスクは日付の近いものから3件だけ。1マスは空にして、画面側で手動選択させる。 */
const tasks = (raw.tasks || []).map(t => t.n).slice(0, 8);

writeFileSync("data/events.json", JSON.stringify({
  generated: raw.generated,
  today: raw.today,
  tomorrow: raw.tomorrow,
  events: raw.events,
  tasks,
  mas: "",
  why: "",
}, null, 2));

console.log(`fallback: 予定${(raw.events || []).length}件 / タスク${tasks.length}件`);
