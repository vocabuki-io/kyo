import { writeFileSync } from "node:fs";

/* journal リポジトリの直近を取ってきて journal.local.md に置く。
   Claude が「今いちばんやるべき1マス」を選ぶための材料。
   このファイルは中身が私的なのでコミットしない（.gitignore 済み）。

   トークンが無い・取れなかった場合は空のファイルを置いて正常終了する。
   ジャーナルが読めないだけで、予定と1マスの生成は止めない。 */

const OWNER = process.env.JOURNAL_OWNER || process.env.GITHUB_REPOSITORY_OWNER || "";
const REPO = process.env.JOURNAL_REPO || "journal";
const TOKEN = process.env.JOURNAL_TOKEN || "";
const OUT = "journal.local.md";

const MAX_CHARS = 14000;   // Claudeに渡す上限。古いほうから捨てる
const MONTHS = 2;          // 今月とその前の月

const done = (text, msg) => { writeFileSync(OUT, text); console.log(msg); process.exit(0); };

if (!TOKEN) done("", "JOURNAL_TOKEN が無いので、ジャーナル無しで進みます");
if (!OWNER) done("", "JOURNAL_OWNER が分からないので、ジャーナル無しで進みます");

/* 日本時間の年月。月初の直後でも前月ぶんが読めるように MONTHS ヶ月さかのぼる */
function ym(back) {
  const t = new Date(Date.now() + 9 * 3600 * 1000);
  t.setUTCMonth(t.getUTCMonth() - back);
  return t.getUTCFullYear() + "-" + String(t.getUTCMonth() + 1).padStart(2, "0");
}

async function month(name) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${name}.md`;
  const r = await fetch(url, {
    headers: {
      Authorization: "Bearer " + TOKEN,
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kyou-journal"
    }
  });
  if (r.status === 404) return "";
  if (!r.ok) throw new Error(`${name}.md — GitHub ${r.status}`);
  return await r.text();
}

let text = "";
try {
  const parts = [];
  for (let i = MONTHS - 1; i >= 0; i--) parts.push(await month(ym(i)));
  text = parts.filter(Boolean).join("\n\n---\n\n").trim();
} catch (e) {
  done("", `ジャーナルを取れませんでした（${e.message}）。無しで進みます`);
}

if (!text) done("", "ジャーナルはまだ空です");

/* 長すぎるときは新しいほうを残す。エントリの頭（## ）で切る */
if (text.length > MAX_CHARS) {
  const cut = text.length - MAX_CHARS;
  const head = text.indexOf("\n## ", cut);
  text = (head >= 0 ? text.slice(head + 1) : text.slice(cut));
}

const n = (text.match(/^## /gm) || []).length;
done(text.trim() + "\n", `ジャーナル ${n}件 / ${text.length}文字`);
