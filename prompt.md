data/raw.json と tasks.md を読んで、data/events.json を書き出して。

raw.json の中身:
- events … 今日と明日の予定
- tasks … カレンダーから拾った [タスク] 付きの終日イベント（今後14日分。日付 d と件名 n を持つ）

出力する JSON の形:
{
  "generated": "<raw.jsonのgeneratedをそのまま>",
  "today": "<raw.jsonのtoday>",
  "tomorrow": "<raw.jsonのtomorrow>",
  "events": [ raw.jsonのeventsをそのまま ],
  "mas": "今日やる1件",
  "why": "それを選んだ理由。20文字以内",
  "tasks": ["未着手を短く言い直したもの。1件30文字以内。最大10件。文字列の配列にする"]
}

「mas」の選び方:
- raw.json の tasks と tasks.md の未着手から、あわせて1件だけ選ぶ
- 考えずに今すぐ体が動くところまで割れているものを選ぶ。割れてなければ、その場で割った1手を書く
- 今日の予定の空き時間に収まるものを選ぶ
- 締切や残り日数には触れない
- 軽いものを優先する
- どちらも空なら mas は空文字にする

「tasks」は raw.json の tasks と tasks.md の両方から作る。
同じ内容が両方にあれば1つにまとめる。日付が近いものを先に置く。
質問のスロットに差し込むので短く。
「8/28 ボカ戻せ：pan / Takuan / モリヤ / ゆう にオファーを送る」なら「8/28のオファー送信」くらいに縮める。

events は加工しない。並び替えも削除もしない。
JSON以外のファイルは書き換えない。
