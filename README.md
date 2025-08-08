# Claude to OpenAI Responses API Proxy

```bash
$ bun run --env-file=.env ./src/server.ts
$ ANTHROPIC_BASE_URL="http://localhost:8082" ANTHROPIC_AUTH_TOKEN="some-api-key" claude

```

## 環境変数

本プロキシ / デモで利用される主な環境変数一覧。

| 変数                 | 必須            | 用途 / 説明                                                                   | デフォルト                      | 参照箇所                                                                 |
| -------------------- | --------------- | ----------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| OPENAI_API_KEY       | Yes             | OpenAI Responses API (内部で OpenAI SDK を使用) の認証                        | なし (未設定なら起動時にエラー) | `src/config/environment.ts`, `src/index.ts`                              |
| OPENAI_MODEL         | No              | OpenAI 側へ渡すモデル名。Claude リクエストを Responses API に変換する際に使用 | gpt-4.1 (未設定時に警告)        | `src/converters/request-converter.ts`, 警告: `src/config/environment.ts` |
| PORT                 | No              | Bun で `run-bun.ts` を使って起動する場合のリッスンポート                      | 8082                            | `src/run-bun.ts` (※ `src/server.ts` は現状固定 8082)                     |
| LOG_EVENTS           | No              | ストリームイベントを JSONL に記録するか (`true` で有効)                       | false (未設定扱い)              | `src/utils/stream-state.ts`                                              |
| LOG_DIR              | No              | イベントログ出力ディレクトリ                                                  | ./logs                          | `src/utils/stream-state.ts`                                              |
| ANTHROPIC_BASE_URL   | (外部 CLI 用途) | Anthropic CLI / SDK を本プロキシへ向けるためのエンドポイント指定              | なし                            | README 利用例のみ                                                        |
| ANTHROPIC_AUTH_TOKEN | (外部 CLI 用途) | Anthropic CLI 実行時のダミー/任意トークン (プロキシ側では未使用)              | なし                            | README 利用例のみ                                                        |
| OPENAI_BASE_URL      | No (テスト用)   | OpenAI SDK のベース URL を差し替えるためのテスト用変数                        | https://api.openai.com/v1       | `openai-responses/test-responses-api.ts`                                 |

## .env のサンプル

最小構成:

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
OPENAI_MODEL=gpt-4.1-mini
PORT=8082
LOG_EVENTS=true          # 必要に応じて
LOG_DIR=./logs           # 任意
```

Anthropic CLI をこのプロキシへ向ける例:

```bash
export ANTHROPIC_BASE_URL="http://localhost:8082"
export ANTHROPIC_AUTH_TOKEN="dummy-token"
claude messages create ...
```

## 起動方法

```bash
bun install
bun run --env-file=.env ./src/server.ts
# もしくは
bun run --env-file=.env src/run-bun.ts
```

## ログ出力

`LOG_EVENTS=true` の場合、`LOG_DIR` (既定: `./logs`) 配下にストリームイベントが JSON Lines 形式で保存されます。
