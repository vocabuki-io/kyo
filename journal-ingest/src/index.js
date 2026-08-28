/*
 * journal-ingest ─ アプリ → Cloudflare Worker → journal リポジトリ
 *
 * きょう/とい で答えた内容を、journal リポジトリの YYYY-MM.md に追記する。
 * ついでに「次の1マスを選び直して」を GitHub Actions に投げる。
 * Cloudflare の画面に、このファイルの中身をそのまま貼って使う。
 *
 * 必要な設定（Settings → Variables and Secrets）
 *   GITHUB_OWNER  Text    GitHubのユーザー名
 *   GITHUB_REPO   Text    journal
 *   GITHUB_TOKEN  Secret  github_pat_... （Contents: Read and write）
 *   INGEST_TOKEN  Secret  アプリと共有する合言葉
 *
 * 任意
 *   GITHUB_BRANCH  Text  既定は リポジトリの既定ブランチ
 *   JOURNAL_DIR    Text  置き場所（例 "log"）。既定は リポジトリ直下
 *   ALLOWED_ORIGIN Text  許可する送信元。既定は "*"
 *
 * 任意（次の1マスを頼むときだけ）
 *   APP_REPO        Text    きょう/とい のリポジトリ。既定は "kyo"
 *   APP_WORKFLOW    Text    起動するワークフロー。既定は "build.yml"
 *   APP_BRANCH      Text    起動するブランチ。既定は "main"
 *   APP_OWNER       Text    既定は GITHUB_OWNER
 *   DISPATCH_TOKEN  Secret  Actions を起動できるトークン。既定は GITHUB_TOKEN
 *
 * エンドポイント
 *   GET  /         生存確認。{"ok":true,...} を返す（合言葉は要らない）
 *   POST /ingest   追記。合言葉が要る（POST / でも同じ）
 *   POST /next     次の1マスを選び直させる。合言葉が要る
 */

const API = "https://api.github.com";
const UA = "journal-ingest";
const MAX_BODY = 256 * 1024;  // 受け取る本文の上限
const MAX_ENTRIES = 200;      // 1回に書ける件数の上限
const MAX_CHARS = 20000;      // 1件の文字数の上限
const RETRY = 3;              // 同時書き込みでぶつかったときのやり直し回数

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && path === "/") {
      return json({
        ok: true,
        name: "journal-ingest",
        repo: env.GITHUB_OWNER && env.GITHUB_REPO
          ? env.GITHUB_OWNER + "/" + env.GITHUB_REPO
          : null,
        configured: !!(env.GITHUB_OWNER && env.GITHUB_REPO && env.GITHUB_TOKEN && env.INGEST_TOKEN),
        canDispatch: !!(env.GITHUB_OWNER && env.INGEST_TOKEN && (env.DISPATCH_TOKEN || env.GITHUB_TOKEN)),
        time: new Date().toISOString()
      }, 200, origin);
    }

    const isNext = path === "/next";
    if (request.method !== "POST" || (path !== "/" && path !== "/ingest" && !isNext)) {
      return fail("not_found", "そのアドレスはありません", 404, origin);
    }

    // ---- 設定の確認 ----
    const need = isNext
      ? ["GITHUB_OWNER", "INGEST_TOKEN"]
      : ["GITHUB_OWNER", "GITHUB_REPO", "GITHUB_TOKEN", "INGEST_TOKEN"];
    for (const k of need) {
      if (!env[k]) return fail("not_configured", "Workerの設定が足りません（" + k + "）", 500, origin);
    }
    if (isNext && !(env.DISPATCH_TOKEN || env.GITHUB_TOKEN)) {
      return fail("not_configured", "Workerの設定が足りません（DISPATCH_TOKEN）", 500, origin);
    }

    // ---- 本文を読む ----
    const raw = await request.text();
    if (raw.length > MAX_BODY) return fail("too_large", "送る内容が大きすぎます", 413, origin);

    let payload;
    try { payload = JSON.parse(raw || "{}"); }
    catch (_) { return fail("bad_json", "送る内容の形が違います", 400, origin); }

    // ---- 合言葉 ----
    const given = bearer(request) || request.headers.get("x-ingest-token") || payload.token || "";
    if (!safeEqual(given, env.INGEST_TOKEN)) {
      return fail("bad_token", "合言葉が違います", 401, origin);
    }

    // ---- 次の1マスを選び直させる ----
    if (isNext) {
      try {
        await dispatch(env);
        return json({ ok: true, dispatched: true }, 200, origin);
      } catch (e) {
        return fail("dispatch", "次の1マスを頼めません（" + e.message + "）", 502, origin);
      }
    }

    // ---- 書くものを組み立てる ----
    let entries;
    try { entries = normalize(payload); }
    catch (e) { return fail("bad_request", e.message, 400, origin); }

    if (!entries.length) return json({ ok: true, written: 0, skipped: 0, files: [] }, 200, origin);

    // ---- 月ごとにまとめて追記 ----
    const byFile = new Map();
    for (const e of entries) {
      const f = filePath(env, e.at);
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(e);
    }

    const files = [];
    let written = 0, skipped = 0;
    try {
      for (const [file, list] of byFile) {
        const r = await appendToFile(env, file, list);
        files.push({ file, written: r.written, skipped: r.skipped, commit: r.commit });
        written += r.written;
        skipped += r.skipped;
      }
    } catch (e) {
      return fail("github", "書き込みに失敗（" + e.message + "）", 502, origin);
    }

    return json({ ok: true, written, skipped, files }, 200, origin);
  }
};

/* ================= 受け取った内容を整える ================= */

/*
 * 受け付ける形（どれでもよい）
 *   {"entries":[{"at":"...","title":"...","lines":["..."]}]}
 *   {"entries":[{"at":"...","text":"..."}]}
 *   {"items":[...]}            entries と同じ
 *   {"text":"...","at":"..."}  1件だけ
 *   {"lines":["..."],"title":"..."}
 */
function normalize(payload) {
  let list = payload.entries || payload.items;
  if (!list) {
    if (payload.text || payload.lines || payload.title) list = [payload];
    else list = [];
  }
  if (!Array.isArray(list)) throw new Error("entries は配列で送ってください");
  if (list.length > MAX_ENTRIES) throw new Error("1回に送れるのは " + MAX_ENTRIES + " 件までです");

  const out = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;

    let body = "";
    if (Array.isArray(it.lines)) body = it.lines.map(s => String(s == null ? "" : s).trim()).filter(Boolean).join("\n");
    else if (it.text != null) body = String(it.text).trim();

    const title = it.title != null ? String(it.title).trim() : "";
    if (title) body = body ? title + "\n" + body : title;

    body = body.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!body) continue;
    if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + "\n（以下省略）";

    out.push({ at: jst(it.at), body });
  }
  return out;
}

/* 受け取った時刻を日本時間に直す。無ければ今 */
function jst(v) {
  let d = v ? new Date(v) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  const t = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return {
    ym: t.getUTCFullYear() + "-" + p(t.getUTCMonth() + 1),
    head: t.getUTCFullYear() + "-" + p(t.getUTCMonth() + 1) + "-" + p(t.getUTCDate()) +
          " " + p(t.getUTCHours()) + ":" + p(t.getUTCMinutes())
  };
}

function filePath(env, at) {
  const dir = (env.JOURNAL_DIR || "").replace(/^\/+|\/+$/g, "");
  return (dir ? dir + "/" : "") + at.ym + ".md";
}

/* ================= 次の1マスを頼む ================= */

/* きょう/とい のリポジトリのワークフローを起動する。
   Claude がジャーナルとカレンダーを読み直して events.json を書き替え、
   アプリはそれが出てくるのを待つ。 */
async function dispatch(env) {
  const owner = env.APP_OWNER || env.GITHUB_OWNER;
  const repo = env.APP_REPO || "kyo";
  const wf = env.APP_WORKFLOW || "build.yml";
  const ref = env.APP_BRANCH || "main";

  const r = await fetch(API + "/repos/" + owner + "/" + repo +
    "/actions/workflows/" + encodeURIComponent(wf) + "/dispatches", {
    method: "POST",
    body: JSON.stringify({ ref, inputs: { reason: "mas-done" } }),
    headers: {
      "Authorization": "Bearer " + (env.DISPATCH_TOKEN || env.GITHUB_TOKEN),
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": UA
    }
  });

  if (r.status === 204) return;
  if (r.status === 403 || r.status === 401) throw new Error("トークンに Actions の権限がありません");
  if (r.status === 404) throw new Error(repo + " か " + wf + " が見つかりません");
  throw new Error(await ghError(r));
}

/* ================= GitHubへの追記 ================= */

async function appendToFile(env, file, list) {
  let last;
  for (let i = 0; i < RETRY; i++) {
    const cur = await getFile(env, file);
    const merged = merge(cur.text, list);
    if (!merged.written) return { written: 0, skipped: merged.skipped, commit: null };

    const res = await putFile(env, file, merged.text, cur.sha, commitMessage(list));
    if (res.ok) return { written: merged.written, skipped: merged.skipped, commit: res.commit };

    // 409 / 422 は「その間に誰かが書いた」なので読み直してやり直す
    last = res.error;
    if (res.status !== 409 && res.status !== 422) throw new Error(last);
  }
  throw new Error(last || "やり直しても書けませんでした");
}

/* 既にある同じ内容は書かない（送り直しで二重にならないように） */
function merge(text, list) {
  let body = String(text || "").replace(/\s+$/, "");
  let written = 0, skipped = 0;

  for (const e of list) {
    const block = "## " + e.at.head + "\n\n" + e.body;
    if (body.indexOf(block) >= 0) { skipped++; continue; }
    const sep = body ? (/(^|\n)---$/.test(body) ? "\n\n" : "\n\n---\n\n") : "";
    body = body + sep + block;
    written++;
  }
  return { text: body + "\n", written, skipped };
}

function commitMessage(list) {
  const head = list[0].at.head;
  return "journal-ingest: " + head + (list.length > 1 ? "（" + list.length + "件）" : "");
}

async function getFile(env, file) {
  const r = await gh(env, "/repos/" + env.GITHUB_OWNER + "/" + env.GITHUB_REPO +
    "/contents/" + encodePath(file) + (env.GITHUB_BRANCH ? "?ref=" + encodeURIComponent(env.GITHUB_BRANCH) : ""));

  if (r.status === 404) return { text: "", sha: null };   // まだ無い月。新しく作る
  if (!r.ok) throw new Error(await ghError(r));

  const j = await r.json();
  if (Array.isArray(j)) throw new Error(file + " はフォルダです");

  if (j.encoding === "base64" && j.content) return { text: fromB64(j.content), sha: j.sha };

  // 1MBを超えるファイルは content が空で返る。blob から取り直す
  if (j.size > 0 && j.sha) {
    const b = await gh(env, "/repos/" + env.GITHUB_OWNER + "/" + env.GITHUB_REPO + "/git/blobs/" + j.sha);
    if (!b.ok) throw new Error(await ghError(b));
    const bj = await b.json();
    if (bj.encoding !== "base64" || !bj.content) throw new Error(file + " を読めませんでした");
    return { text: fromB64(bj.content), sha: j.sha };
  }
  return { text: "", sha: j.sha || null };
}

async function putFile(env, file, text, sha, message) {
  const body = { message, content: toB64(text) };
  if (sha) body.sha = sha;
  if (env.GITHUB_BRANCH) body.branch = env.GITHUB_BRANCH;

  const r = await gh(env, "/repos/" + env.GITHUB_OWNER + "/" + env.GITHUB_REPO +
    "/contents/" + encodePath(file), { method: "PUT", body: JSON.stringify(body) });

  if (!r.ok) return { ok: false, status: r.status, error: await ghError(r) };
  const j = await r.json();
  return { ok: true, commit: j.commit && j.commit.sha ? j.commit.sha.slice(0, 7) : null };
}

function gh(env, path, init) {
  return fetch(API + path, {
    method: (init && init.method) || "GET",
    body: init && init.body,
    headers: {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": UA
    }
  });
}

async function ghError(r) {
  let msg = "";
  try { const j = await r.json(); msg = j.message || ""; } catch (_) {}
  if (r.status === 401 || r.status === 403) msg = msg || "トークンの権限が足りません";
  if (r.status === 404) msg = msg || "リポジトリが見つかりません";
  return "GitHub " + r.status + (msg ? " " + msg : "");
}

const encodePath = p => p.split("/").map(encodeURIComponent).join("/");

/* ================= こまごま ================= */

function toB64(s) {
  const b = new TextEncoder().encode(s);
  let out = "";
  for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(out);
}

function fromB64(s) {
  const bin = atob(String(s).replace(/\s+/g, ""));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(b);
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

/* 文字数で早く抜けないように、全部比べてから判定する */
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (!a || !b) return false;
  const ab = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Ingest-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, cors(origin || "*"))
  });
}

const fail = (error, message, status, origin) => json({ ok: false, error, message }, status, origin);
