/*
 * journal-ingest の中身をそのまま動かして確かめる。
 * GitHubは偽物に差し替えるので、本物のリポジトリには何も書かない。
 *
 *   node journal-ingest/test/worker.test.mjs
 */
import worker from "../src/index.js";

const FILES = new Map();           // path -> {text, sha}
let putCount = 0, conflictOnce = false;
const DISPATCHED = [];
let DISPATCH_STATUS = 204;
const b64 = s => Buffer.from(s, "utf8").toString("base64");
const unb64 = s => Buffer.from(s, "base64").toString("utf8");

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const R = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });
  const d = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/);
  if (d) {
    DISPATCHED.push({ owner: d[1], repo: d[2], workflow: decodeURIComponent(d[3]), body: JSON.parse(init.body) });
    if (DISPATCH_STATUS !== 204) return R({ message: "nope" }, DISPATCH_STATUS);
    return new Response(null, { status: 204 });
  }
  const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[3]);
    if ((init.method || "GET") === "GET") {
      const f = FILES.get(path);
      if (!f) return R({ message: "Not Found" }, 404);
      return R({ encoding: "base64", content: b64(f.text), sha: f.sha, size: f.text.length });
    }
    if (init.method === "PUT") {
      putCount++;
      const body = JSON.parse(init.body);
      const f = FILES.get(path);
      if (conflictOnce) { conflictOnce = false; return R({ message: "does not match" }, 409); }
      if ((f ? f.sha : null) !== (body.sha || null)) return R({ message: "sha mismatch" }, 409);
      const text = unb64(body.content);
      FILES.set(path, { text, sha: "sha" + putCount });
      return R({ content: { path }, commit: { sha: "c0ffee1234567" } });
    }
  }
  return R({ message: "unexpected " + u.pathname }, 500);
};

const ENV = { GITHUB_OWNER: "me", GITHUB_REPO: "journal", GITHUB_TOKEN: "gh", INGEST_TOKEN: "aikotoba-1234" };
const post = (body, token = "aikotoba-1234", path = "/ingest") =>
  worker.fetch(new Request("https://w.dev" + path, {
    method: "POST",
    headers: token ? { Authorization: "Bearer " + token, "Content-Type": "application/json" } : {},
    body: JSON.stringify(body)
  }), ENV);

let pass = 0, failn = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("  ok  " + name); } else { failn++; console.log("  FAIL " + name, extra ?? ""); } };

console.log("— 生存確認");
let r = await worker.fetch(new Request("https://w.dev/"), ENV);
let j = await r.json();
ok("GET / は ok:true", r.status === 200 && j.ok === true && j.repo === "me/journal", j);

console.log("— 合言葉");
r = await post({ text: "x" }, "chigau");
j = await r.json();
ok("違う合言葉は401", r.status === 401 && j.error === "bad_token" && j.message === "合言葉が違います", j);
r = await post({ text: "x" }, "");
ok("合言葉なしは401", r.status === 401);

console.log("— はじめての書き込み");
r = await post({ entries: [{ at: "2026-08-27T10:03:00Z", title: "【とい】8/27", lines: ["・今なにしてる? → コード書いてる 😊", "・なに食べた? → ラーメン"] }] });
j = await r.json();
ok("200 written:1", r.status === 200 && j.ok && j.written === 1, j);
ok("2026-08.md ができた", FILES.has("2026-08.md"), [...FILES.keys()]);
let t = FILES.get("2026-08.md").text;
ok("JSTの見出し（10:03Z→19:03）", t.startsWith("## 2026-08-27 19:03\n"), JSON.stringify(t.slice(0, 40)));
ok("題と行が入っている", t.includes("【とい】8/27") && t.includes("・なに食べた? → ラーメン"), t);
ok("末尾は改行1つ", t.endsWith("\n") && !t.endsWith("\n\n"), JSON.stringify(t.slice(-6)));

console.log("— 2件目は --- で区切って下に足す");
r = await post({ entries: [{ at: "2026-08-27T11:00:00Z", text: "【1マス完了】垂れ幕を発注する" }] });
j = await r.json();
t = FILES.get("2026-08.md").text;
ok("written:1", j.written === 1, j);
ok("--- が1つ入る", (t.match(/\n---\n/g) || []).length === 1, t);
ok("あとの分が下にある", t.indexOf("【1マス完了】") > t.indexOf("【とい】"), t);

console.log("— 送り直しても二重にならない");
r = await post({ entries: [{ at: "2026-08-27T11:00:00Z", text: "【1マス完了】垂れ幕を発注する" }] });
j = await r.json();
ok("skipped:1 written:0", j.written === 0 && j.skipped === 1, j);
ok("中身は変わらない", (FILES.get("2026-08.md").text.match(/垂れ幕を発注する/g) || []).length === 1);

console.log("— 月をまたぐと別ファイル");
r = await post({ entries: [{ at: "2026-08-31T16:00:00Z", text: "9月ぶん" }, { at: "2026-08-27T12:00:00Z", text: "8月ぶん" }] });
j = await r.json();
ok("2ファイルに書かれた", j.written === 2 && FILES.has("2026-09.md") && FILES.get("2026-09.md").text.includes("9月ぶん"), [...FILES.keys()]);
ok("9/1 01:00 として入る", FILES.get("2026-09.md").text.startsWith("## 2026-09-01 01:00"), FILES.get("2026-09.md").text);

console.log("— 同時書き込みでぶつかってもやり直す");
conflictOnce = true;
r = await post({ entries: [{ at: "2026-08-27T13:00:00Z", text: "ぶつかっても入る" }] });
j = await r.json();
ok("やり直して成功", r.status === 200 && j.written === 1 && FILES.get("2026-08.md").text.includes("ぶつかっても入る"), j);

console.log("— いろんな送りかた");
r = await post({ text: "単発", at: "2026-08-27T14:00:00Z" });
ok("{text} 単体でも書ける", (await r.json()).written === 1);
r = await post({ items: [{ lines: ["items でも通る"], at: "2026-08-27T14:10:00Z" }] });
ok("items でも通る", (await r.json()).written === 1);
r = await worker.fetch(new Request("https://w.dev/", { method: "POST", headers: { "X-Ingest-Token": "aikotoba-1234" }, body: JSON.stringify({ text: "POST / でも通る", at: "2026-08-27T14:20:00Z" }) }), ENV);
ok("POST / と X-Ingest-Token でも通る", (await r.json()).written === 1);
r = await post({ entries: [] });
ok("空でも200", (await r.json()).written === 0);
r = await post({ entries: [{ text: "   " }] });
ok("空白だけは書かない", (await r.json()).written === 0);

console.log("— CORS");
r = await worker.fetch(new Request("https://w.dev/ingest", { method: "OPTIONS" }), ENV);
ok("preflightは204", r.status === 204 && r.headers.get("access-control-allow-origin") === "*");
ok("POSTの返事にもCORS", (await post({ text: "z", at: "2026-08-27T15:00:00Z" })).headers.get("access-control-allow-origin") === "*");

console.log("— 設定もれ / 変な入力");
r = await worker.fetch(new Request("https://w.dev/ingest", { method: "POST", headers: { Authorization: "Bearer x" }, body: "{}" }), { INGEST_TOKEN: "x" });
j = await r.json();
ok("設定もれは500で名前が出る", r.status === 500 && j.error === "not_configured" && j.message.includes("GITHUB_OWNER"), j);
r = await worker.fetch(new Request("https://w.dev/ingest", { method: "POST", headers: { Authorization: "Bearer aikotoba-1234" }, body: "{" }), ENV);
ok("壊れたJSONは400", r.status === 400 && (await r.json()).error === "bad_json");
r = await worker.fetch(new Request("https://w.dev/nope", { method: "POST" }), ENV);
ok("知らないアドレスは404", r.status === 404);
r = await post({ entries: [{ text: "x", at: "こわれた日付" }] });
ok("壊れた日付でも今の時刻で書ける", (await r.json()).written === 1);

console.log("— GitHubが失敗したとき");
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 });
r = await post({ text: "だめ", at: "2026-08-27T16:00:00Z" });
j = await r.json();
ok("502 と「書き込みに失敗」", r.status === 502 && j.error === "github" && j.message.startsWith("書き込みに失敗"), j);
globalThis.fetch = realFetch;

console.log("— 次の1マスを頼む");
r = await post({}, "aikotoba-1234", "/next");
j = await r.json();
ok("200 dispatched", r.status === 200 && j.ok && j.dispatched === true, j);
ok("kyo の build.yml を main で起動した",
  DISPATCHED.length === 1 && DISPATCHED[0].repo === "kyo" && DISPATCHED[0].owner === "me" &&
  DISPATCHED[0].workflow === "build.yml" && DISPATCHED[0].body.ref === "main", DISPATCHED);
ok("理由が入る", DISPATCHED[0].body.inputs.reason === "mas-done", DISPATCHED[0].body);

r = await post({}, "chigau", "/next");
ok("合言葉が違えば起動しない", r.status === 401 && DISPATCHED.length === 1);

DISPATCHED.length = 0;
r = await worker.fetch(new Request("https://w.dev/next", {
  method: "POST", headers: { Authorization: "Bearer aikotoba-1234" }, body: "{}"
}), { ...ENV, APP_REPO: "kyou-app", APP_WORKFLOW: "mas.yml", APP_BRANCH: "prod", APP_OWNER: "hoka" });
ok("行き先は差し替えられる",
  DISPATCHED[0].owner === "hoka" && DISPATCHED[0].repo === "kyou-app" &&
  DISPATCHED[0].workflow === "mas.yml" && DISPATCHED[0].body.ref === "prod", DISPATCHED[0]);

DISPATCH_STATUS = 403;
r = await post({}, "aikotoba-1234", "/next");
j = await r.json();
ok("権限が無ければ502で理由が出る",
  r.status === 502 && j.error === "dispatch" && j.message.includes("Actions の権限"), j);
DISPATCH_STATUS = 404;
r = await post({}, "aikotoba-1234", "/next");
ok("見つからなければ502", (await r.json()).message.includes("見つかりません"));
DISPATCH_STATUS = 204;

r = await worker.fetch(new Request("https://w.dev/next", {
  method: "POST", headers: { Authorization: "Bearer x" }, body: "{}"
}), { GITHUB_OWNER: "me", INGEST_TOKEN: "x" });
j = await r.json();
ok("トークンが無ければ500で名前が出る",
  r.status === 500 && j.error === "not_configured" && j.message.includes("DISPATCH_TOKEN"), j);

r = await worker.fetch(new Request("https://w.dev/next", {
  method: "POST", headers: { Authorization: "Bearer x" }, body: "{}"
}), { GITHUB_OWNER: "me", INGEST_TOKEN: "x", DISPATCH_TOKEN: "d" });
ok("追記の設定が無くても /next は通る", r.status === 200);

r = await worker.fetch(new Request("https://w.dev/"), ENV);
ok("生存確認に canDispatch が出る", (await r.json()).canDispatch === true);

console.log("\n===== 最終の 2026-08.md =====");
console.log(FILES.get("2026-08.md").text);
console.log("=====", pass, "ok /", failn, "fail =====");
process.exit(failn ? 1 : 0);
