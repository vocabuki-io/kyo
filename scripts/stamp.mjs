import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

/* 1マスが前回から変わったときだけ masAt を今の時刻にする。
   アプリはこの masAt で「次の1マスがもう出たか」を見分ける。
   同じ1マスが選び直されたときに masAt を動かすと、
   終わっていないものを新しいものとして出してしまうので動かさない。 */

const F = "data/events.json";
const cur = JSON.parse(readFileSync(F, "utf8"));

let prev = {};
try { prev = JSON.parse(execSync(`git show HEAD:${F}`, { encoding: "utf8" })); }
catch (e) { console.log("前回の events.json が無いので、新しい1マスあつかいにします"); }

const same = prev.mas && prev.mas === cur.mas;
cur.masAt = same ? (prev.masAt || new Date().toISOString()) : new Date().toISOString();

writeFileSync(F, JSON.stringify(cur, null, 2) + "\n");
console.log(same ? `1マスは据え置き（${cur.mas}）` : `1マスが変わった → ${cur.mas || "（なし）"} / ${cur.masAt}`);
