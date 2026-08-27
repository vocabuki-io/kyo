import ical from "node-ical";
import { writeFileSync, mkdirSync } from "node:fs";

/* ===== 設定 ===== */
const BOUND = 6;                       // 夜勤対応：朝6時までは前日あつかい
const TZ = "Asia/Tokyo";

/* ICSのURLは環境変数から。カンマ区切りで複数。
   形式: ラベル|URL  （ラベルは画面に出す短い名前） */
const SRC = (process.env.ICS_URLS || "")
  .split(",").map(s => s.trim()).filter(Boolean)
  .map(s => {
    const i = s.indexOf("|");
    return i < 0 ? { label: "", url: s } : { label: s.slice(0, i), url: s.slice(i + 1) };
  });

if (!SRC.length) { console.error("ICS_URLS が空"); process.exit(1); }

/* ===== 日付ユーティリティ ===== */
const jst = d => new Date(d.toLocaleString("en-US", { timeZone: TZ }));
const pad = n => String(n).padStart(2, "0");
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function logical(d) { const x = new Date(d); if (x.getHours() < BOUND) x.setDate(x.getDate() - 1); return x; }
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const now = jst(new Date());
const d0 = logical(now);
const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
const K0 = key(d0), K1 = key(d1);

/* 予定の取得範囲：今日の朝6時 〜 明後日の朝6時 */
const from = new Date(d0); from.setHours(BOUND, 0, 0, 0);
const to = new Date(d1); to.setDate(to.getDate() + 1); to.setHours(BOUND, 0, 0, 0);

/* タスク（[タスク]付きの終日イベント）は先まで拾う */
const TASK_DAYS = 14;
const taskTo = new Date(d0); taskTo.setDate(taskTo.getDate() + TASK_DAYS); taskTo.setHours(BOUND, 0, 0, 0);

/* [タスク] / [ﾀｽｸ] の前置を判定して外す */
const TASK_RE = /^\s*[\[［]\s*(タスク|ﾀｽｸ|TASK|task)\s*[\]］]\s*/;
const isTask = s => TASK_RE.test(s || "");
const stripTask = s => (s || "").replace(TASK_RE, "").trim();

/* ===== 収集 ===== */
const out = [];
const tasksOut = [];
for (const { label, url } of SRC) {
  let data;
  try { data = await ical.async.fromURL(url); }
  catch (e) { console.error(`取得失敗: ${label || url} — ${e.message}`); continue; }

  for (const k in data) {
    const ev = data[k];
    if (!ev || ev.type !== "VEVENT") continue;

    const push = (start, end) => {
      const s = jst(start);
      const raw = (ev.summary || "(無題)").trim();
      const allDay = ev.datetype === "date";

      /* [タスク] 付きは予定ではなくタスクとして別に集める */
      if (isTask(raw)) {
        if (s < from || s >= taskTo) return;
        tasksOut.push({ d: key(logical(s)), n: stripTask(raw), cal: label });
        return;
      }

      if (s < from || s >= to) return;
      out.push({
        d: key(logical(s)),
        t: allDay ? "--:--" : hhmm(s),
        n: raw,
        cal: label,
        allDay,
        end: end && !allDay ? hhmm(jst(end)) : null,
      });
    };

    if (ev.rrule) {
      const dur = (ev.end && ev.start) ? ev.end - ev.start : 0;
      const dates = ev.rrule.between(new Date(from.getTime() - 864e5), to, true);
      const ex = Object.values(ev.exdate || {}).map(x => new Date(x).getTime());
      for (const dt of dates) {
        if (ex.some(x => Math.abs(x - dt.getTime()) < 6e4)) continue;
        push(dt, new Date(dt.getTime() + dur));
      }
    } else {
      push(ev.start, ev.end);
    }
  }
}

/* 重複除去＋並べ替え（6時未満は翌日扱いで後ろへ） */
const seen = new Set();
const mins = t => { if (t === "--:--") return -1; const [h, m] = t.split(":").map(Number); return (h < BOUND ? h + 24 : h) * 60 + m; };
const events = out
  .filter(e => {
    const id = `${e.d}|${e.t}|${e.n}`;
    if (seen.has(id)) return false; seen.add(id); return true;
  })
  .sort((a, b) => a.d.localeCompare(b.d) || mins(a.t) - mins(b.t));

/* タスクも重複除去して日付順に */
const tseen = new Set();
const tasks = tasksOut
  .filter(e => {
    const id = `${e.d}|${e.n}`;
    if (tseen.has(id)) return false; tseen.add(id); return true;
  })
  .sort((a, b) => a.d.localeCompare(b.d));

mkdirSync("data", { recursive: true });
writeFileSync("data/raw.json", JSON.stringify({
  generated: now.toISOString(), today: K0, tomorrow: K1, events, tasks
}, null, 2));

console.log(`予定 ${events.length}件 (${K0} / ${K1})`);
for (const e of events) console.log(` ${e.d} ${e.t} ${e.n}${e.cal ? ` [${e.cal}]` : ""}`);
console.log(`タスク ${tasks.length}件 (今後${TASK_DAYS}日)`);
for (const e of tasks) console.log(` ${e.d} ${e.n}${e.cal ? ` [${e.cal}]` : ""}`);
