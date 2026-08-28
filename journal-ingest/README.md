# journal-ingest

アプリ → Cloudflare Worker → `journal` リポジトリに追記。

置きかたは [SETUP.md](SETUP.md)。ここは中身の説明。

```
きょう/とい（Cloudflare Pages）
  └ 答えたものを端末に貯める（localStorage）
       ├ POST /ingest ─→ journal-ingest（Worker）
       │                    └ GitHub Contents API ─→ journal/YYYY-MM.md
       └ POST /next   ─→ journal-ingest（Worker）
                            └ workflow_dispatch ─→ kyo の build.yml
                                                     └ Claude がジャーナルと
                                                        カレンダーを読んで
                                                        次の1マスを選ぶ
```

書き込みはWorkerだけがやる。アプリはGitHubのトークンを持たない。
アプリが持つのは合言葉（`INGEST_TOKEN`）だけで、これが漏れても
書けるのはジャーナルへの追記だけになる。

## 設定

| 名前 | Type | 要否 | 中身 |
|---|---|---|---|
| `GITHUB_OWNER` | Text | 必須 | GitHubのユーザー名 |
| `GITHUB_REPO` | Text | 必須 | `journal` |
| `GITHUB_TOKEN` | Secret | 必須 | Fine-grained PAT（`journal` の Contents: Read and write） |
| `INGEST_TOKEN` | Secret | 必須 | アプリと共有する合言葉 |
| `GITHUB_BRANCH` | Text | 任意 | 既定はリポジトリの既定ブランチ |
| `JOURNAL_DIR` | Text | 任意 | 既定はリポジトリ直下 |
| `ALLOWED_ORIGIN` | Text | 任意 | 既定は `*` |
| `APP_REPO` | Text | 任意 | アプリのリポジトリ。既定は `kyo` |
| `APP_OWNER` | Text | 任意 | 既定は `GITHUB_OWNER` |
| `APP_WORKFLOW` | Text | 任意 | 既定は `build.yml` |
| `APP_BRANCH` | Text | 任意 | 既定は `main` |
| `DISPATCH_TOKEN` | Secret | 任意 | Actions用の別トークン。既定は `GITHUB_TOKEN` |

`/next` を使うなら、トークンに `kyo` の **Actions: Read and write** が要る。
`GITHUB_TOKEN` に足すか、`DISPATCH_TOKEN` を別に置く。

## エンドポイント

### `GET /`

生存確認。合言葉は要らない。

```json
{"ok":true,"name":"journal-ingest","repo":"you/journal","configured":true,"time":"..."}
```

`configured` が `false` なら、追記に必要な変数が足りていない。
`canDispatch` が `false` なら、`/next` に必要なものが足りていない。

### `POST /ingest`

追記する。`POST /` でも同じ。合言葉は次のどれかで渡す。

- `Authorization: Bearer <合言葉>`
- `X-Ingest-Token: <合言葉>`
- 本文の `token`（ヘッダに入らない文字を使うとき。アプリはこちらに切り替える）

```jsonc
{
  "entries": [
    {
      "at": "2026-08-27T10:03:00Z",   // 省くと今。日本時間に直して使う
      "title": "【とい】8/27",         // 省いてよい
      "lines": ["・今なにしてる? → コード書いてる 😊"]
    },
    { "at": "...", "text": "【1マス完了】垂れ幕の即日依頼を考える" }
  ]
}
```

`entries` は `items` でもよい。1件だけなら `{"text":"...","at":"..."}` と直接書ける。

返り：

```json
{"ok":true,"written":1,"skipped":0,"files":[{"file":"2026-08.md","written":1,"skipped":0,"commit":"a1b2c3d"}]}
```

失敗したとき（`message` はそのまま画面に出る文言）：

| status | error | message |
|---|---|---|
| 400 | `bad_json` / `bad_request` | 送る内容の形が違います |
| 401 | `bad_token` | 合言葉が違います |
| 404 | `not_found` | そのアドレスはありません |
| 413 | `too_large` | 送る内容が大きすぎます |
| 500 | `not_configured` | Workerの設定が足りません（〜） |
| 502 | `github` | 書き込みに失敗（〜） |

### `POST /next`

次の1マスを選び直させる。合言葉は `/ingest` と同じ渡しかた。本文は要らない。

`kyo` の `build.yml` を `workflow_dispatch` で起こすだけで、すぐ返る。
Claude が選び終わるまで待たない。アプリ側が `data/events.json` を見に行く。

```json
{"ok":true,"dispatched":true}
```

| status | error | message |
|---|---|---|
| 401 | `bad_token` | 合言葉が違います |
| 500 | `not_configured` | Workerの設定が足りません（DISPATCH_TOKEN） |
| 502 | `dispatch` | 次の1マスを頼めません（〜） |

## 1マスの受け渡し

`data/events.json` の `masAt` が、アプリが「次の1マスが出たか」を見分ける印。

- `scripts/stamp.mjs` が、**`mas` が前回から変わったときだけ** `masAt` を打ち直す
- アプリは完了させた `masAt` を覚えていて、それと違う `masAt` が来たら新しい1マスとして出す
- 8分待っても変わらなければ「まだ出ていません」に変えて、たのみ直せるようにする

## 書きかた

`YYYY-MM.md` の末尾に `---` で区切って足す。時刻は日本時間。

```
## 2026-08-27 19:03

【とい】8/27
・今なにしてる? → コード書いてる 😊
```

- 月が変わると新しいファイルを作る
- 同じ中身が既にあれば書かない（送り直しても二重にならない）
- 同時に書いてぶつかったら、読み直して3回までやり直す

## 動かして確かめる

```sh
node journal-ingest/test/worker.test.mjs
```

偽のGitHubを相手に、Workerの中身をそのまま動かす。node以外は要らない。

## コードを直したときは貼り直す

Cloudflareのダッシュボードに貼って使っている場合、**このリポジトリの
`src/index.js` を直しても、動いているWorkerは変わらない。**
貼り付け直して Deploy するまで、古いコードのまま動き続ける。

貼り直したかどうかは `GET /` で分かる。返ってくるJSONに、そのとき
足したフィールド（今なら `canDispatch`）が入っていなければ古い。

`wrangler deploy` で置いている場合は、その1回で入れ替わる。

## CLIから置きたいとき

`wrangler.toml` があるので、`journal-ingest/` の中で次を打つ。
Cloudflareの画面に貼るなら要らない。

```sh
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put INGEST_TOKEN
npx wrangler deploy
```

`GITHUB_OWNER` と `GITHUB_REPO` は `wrangler.toml` の `[vars]` に書く。
