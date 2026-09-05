import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

/* Claude が書いた data/toi.json を検める。
   骨格は積み上げるものなので、prompt で「消すな」と書くだけでは足りない。
   消えていたらここで戻す。触れない語も、ここで最後に落とす。

   直せないほど壊れていたら、前のものに戻して落ちる。
   空のプールをアプリに出すくらいなら、古いプールのほうがいい。 */

const F = "data/toi.json";
const CAP_Q = 60, CAP_DIC = 30;

let prev = null;
try { prev = JSON.parse(execSync(`git show HEAD:${F}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch (e) {}

function restore(why) {
  console.error(`::error::${why}`);
  if (prev) { writeFileSync(F, JSON.stringify(prev, null, 2) + "\n"); console.error("前の toi.json に戻した"); }
  process.exit(1);
}

let cur;
try { cur = JSON.parse(readFileSync(F, "utf8")); }
catch (e) { restore(`${F} が JSON として読めない（${e.message}）`); }

/* 触れない語は減らさない。前にあったものは必ず残す */
const ng = [...new Set([...(prev?.ng || []), ...(Array.isArray(cur.ng) ? cur.ng : [])])].filter((w) => typeof w === "string" && w);
const hasNg = (s) => ng.some((w) => String(s).includes(w));

/* 骨格は消さない。Claude が落としたカテゴリは前のものから戻す */
const cats = [];
const seenCat = new Set();
for (const c of [...(Array.isArray(cur.cats) ? cur.cats : []), ...(prev?.cats || [])]) {
  if (!c || typeof c.c !== "string" || !c.c || seenCat.has(c.c)) continue;
  seenCat.add(c.c);
  cats.push({ c: c.c, d: Math.min(2, Math.max(0, Number(c.d) || 0)), aim: String(c.aim || "") });
}
if (!cats.length) restore("cats が空。骨格が消えている");
/* Claude が落としたぶんを数える。足したぶんと相殺しないよう、名前で見る */
const curNames = new Set((Array.isArray(cur.cats) ? cur.cats : []).map((c) => c && c.c).filter(Boolean));
const restored = cats.filter((c) => !curNames.has(c.c)).map((c) => c.c);

/* 固有名詞。触れない語を落として、長さで切る */
const dic = {};
for (const [k, v] of Object.entries(cur.dic && typeof cur.dic === "object" ? cur.dic : {})) {
  if (!Array.isArray(v)) continue;
  const a = [...new Set(v.filter((w) => typeof w === "string" && w && !hasNg(w)))];
  if (a.length) dic[k] = a.slice(-CAP_DIC);
}

/* 出題プール */
const seenQ = new Set();
const dropped = { ng: 0, cat: 0, dup: 0, bad: 0 };
const q = [];
for (const it of Array.isArray(cur.q) ? cur.q : []) {
  const t = it && typeof it.q === "string" ? it.q.trim() : "";
  if (!t || t.length > 60 || /[{}]/.test(t)) { dropped.bad++; continue; }   // 差し込みが残っているものも落とす
  if (hasNg(t)) { dropped.ng++; continue; }
  if (!seenCat.has(it.c)) { dropped.cat++; continue; }
  if (seenQ.has(t)) { dropped.dup++; continue; }
  seenQ.add(t);
  q.push({ q: t, c: it.c, d: Math.min(2, Math.max(0, Number(it.d) || 0)), yn: !!it.yn });
}
if (q.length < 5) restore(`出題プールが ${q.length} 件しか残らなかった`);

/* 中身が前と同じなら generated も据え置く。
   毎回時刻だけ変えると、何も変わっていない日にもコミットが立つ */
const body = { cats, dic, ng, q: q.slice(0, CAP_Q) };
const same = prev && JSON.stringify(body) === JSON.stringify({ cats: prev.cats, dic: prev.dic, ng: prev.ng, q: prev.q });
const out = { generated: same ? prev.generated : new Date().toISOString(), ...body };
writeFileSync(F, JSON.stringify(out, null, 2) + "\n");

const byCat = {};
out.q.forEach((x) => { byCat[x.c] = (byCat[x.c] || 0) + 1; });
console.log(`${same ? "変更なし。" : ""}とい ${out.q.length}件 / カテゴリ ${cats.length}種${restored.length ? `（${restored.join("・")} を戻した）` : ""}`);
console.log("内訳: " + Object.entries(byCat).map(([k, v]) => `${k}${v}`).join(" "));
const d = Object.entries(dropped).filter(([, v]) => v > 0);
if (d.length) console.log("落とした: " + d.map(([k, v]) => `${k}${v}`).join(" "));
