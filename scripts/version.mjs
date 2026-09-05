import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

/* index.html の VER を、これまでマージした回数で埋める。
   手で上げていると必ず忘れるので、履歴から数える。

   数え方。「コミット数」ではない ── cron が毎日 data/ を更新するので、
   全コミット数だと1日に何回も上がってしまい、マージ分にならない。
   マージ1回につき main に1つだけ残るものを数える：
     - squash merge → 件名が「… (#7)」で終わる普通のコミット1つ
     - merge commit → 親が2つのコミット1つ（件名は「Merge pull request #7 …」）
   この2つは重ならないので、足して構わない。
   rebase merge だけは印が残らず数えられない。このリポジトリは squash。 */

const git = (c) => execSync(c, { encoding: "utf8" });

if (git("git rev-parse --is-shallow-repository").trim() === "true") {
  console.error("::error::履歴が浅いので数えられません。checkout に fetch-depth: 0 が要ります");
  process.exit(1);
}

const squash = git("git log --pretty=%s").split("\n").filter((s) => /\(#\d+\)$/.test(s)).length;
const merges = Number(git("git rev-list --count --merges HEAD").trim());
const ver = "v" + (squash + merges);

const F = "index.html";
const src = readFileSync(F, "utf8");
const RE = /(const VER=")v\d+(";)/;

if (!RE.test(src)) {
  console.error(`::error::${F} に const VER="vN" が見つかりません`);
  process.exit(1);
}

const out = src.replace(RE, `$1${ver}$2`);
const changed = out !== src;
if (changed) writeFileSync(F, out);

console.log(changed ? `${ver} に上げた（squash ${squash} + merge ${merges}）` : `${ver} のまま。変更なし`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `ver=${ver}\nchanged=${changed}\n`);
}
