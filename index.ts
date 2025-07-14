// claude-responses-proxy.ts
import { Hono } from "hono";
import { SSEMessage, SSEStreamingApi, streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { v4 as uuid } from "uuid";
import { encoding_for_model } from "@dqbd/tiktoken";
import {
  ResponseFunctionToolCall as OpenAIResponseFunctionToolCall,
  ResponseFunctionToolCallOutputItem as OpenAIResponseFunctionToolCallOutputItem,
  ResponseInputText as OpenAIResponseInputText,
  Responses as OpenAIResponses,
  ResponseStreamEvent as OpenAIResponseStreamEvent,
  ResponseInputMessageContentList as OpenAIResponseInputMessageContentList,
  Tool as OpenAITool,
  ResponseInputItem as OpenAIResponseInputItem,
  EasyInputMessage as OpenAIResponseEasyInputMessage,
  ResponseCreateParamsBase as OpenAIResponseCreateParamsBase,
  ResponseOutputItemAddedEvent as OpenAIResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent as OpenAIResponseOutputItemDoneEvent,
  WebSearchTool as OpenAIWebSearchTool,
} from "openai/resources/responses/responses";

import { ImageURLContentBlock as OpenAIResponseImageURLContentBlock } from "openai/resources/beta/threads";
import { ResponsesModel as OpenAIResponseModel } from "openai/resources/shared";

import {
  TextBlock as ClaudeTextBlock,
  ImageBlockParam as ClaudeContentBlockImage,
  ToolResultBlockParam as ClaudeContentBlockToolResult,
  Tool as ClaudeTool,
  ToolUnion as ClaudeToolUnion,
  MessageCreateParams as ClaudeMessageCreateParams,
  MessageCreateParamsBase as ClaudeMessageCreateParamsBase,
  RawMessageStreamEvent as ClaudeRawMessageStreamEvent,
  RawMessageStartEvent as ClaudeRawMessageStartEvent,
  RawMessageDeltaEvent as ClaudeRawMessageDeltaEvent,
  RawMessageStopEvent as ClaudeRawMessageStopEvent,
  RawContentBlockStartEvent as ClaudeRawContentBlockStartEvent,
  RawContentBlockDeltaEvent as ClaudeRawContentBlockDeltaEvent,
  RawContentBlockStopEvent as ClaudeRawContentBlockStopEvent,
  MessageParam as ClaudeMessageParam,
  Model as ClaudeModel,
} from "@anthropic-ai/sdk/resources/messages";

// 環境変数チェック
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

if (!process.env.OPENAI_MODEL) {
  console.warn(
    "OPENAI_MODEL environment variable is not set, using default gpt-4.1"
  );
}

const DEFAULT_OPENAI_MODEL: OpenAIResponseModel =
  (process.env.OPENAI_MODEL as OpenAIResponseModel) || "gpt-4.1";

// ツール群の型定義

// Web Search Preview ツール定義
export const webSearchPreviewFunction: OpenAIWebSearchTool = {
  type: "web_search_preview",
};

// Bash 実行ツール定義
export const bashFunction: OpenAITool = {
  name: "bash",
  description: "サーバー上でシェルコマンドを実行し、出力を返します。",
  type: "function",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "array",
        items: { type: "string" },
        description: '実行するコマンドと引数のリスト（例: ["ls", "-la"]）',
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  strict: true,
};

// Web 検索ツール定義
export const webSearchFunction: OpenAITool = {
  name: "web_search",
  description: "指定したクエリでウェブ検索を行い、結果を返します。",
  type: "function",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "検索クエリ文字列" },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "検索対象に含めるドメインのリスト",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "検索対象から除外するドメインのリスト",
      },
      max_uses: { type: "integer", description: "ツールを呼び出せる最大回数" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
};

// テキスト編集ツール定義
export const textEditorFunction: OpenAITool = {
  name: "text_editor",
  description: "指定された文字列内で検索・置換を行います。",
  type: "function",
  parameters: {
    type: "object",
    properties: {
      original: { type: "string", description: "元のテキスト" },
      search: { type: "string", description: "検索文字列または正規表現" },
      replace: { type: "string", description: "置換後の文字列" },
      flags: {
        type: "string",
        description: '正規表現フラグ（例: "g"、"i"）',
      },
    },
    required: ["original", "search", "replace"],
    additionalProperties: false,
  },
  strict: true,
};

// =============================================================================
// 設定
// =============================================================================

const modelMap: Partial<Record<ClaudeModel, OpenAIResponseModel>> = {
  "claude-3-5-sonnet-20241022": DEFAULT_OPENAI_MODEL,
  "claude-3-5-haiku-20241022": DEFAULT_OPENAI_MODEL,
  "claude-3-sonnet-20240229": DEFAULT_OPENAI_MODEL,
  "claude-3-haiku-20240307": DEFAULT_OPENAI_MODEL,
  "claude-3-opus-20240229": DEFAULT_OPENAI_MODEL,
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  defaultHeaders: {
    "OpenAI-Beta": "responses-2025-06-21",
  },
});

// =============================================================================
// ユーティリティクラス
// =============================================================================

class StreamState {
  textIndex = 0;
  toolIndex = 0;
  usage = { input_tokens: 0, output_tokens: 0 };
  toolBlockCounter = 0; // ← A準拠のツール用カウンタを追加
  toolCalls: Record<
    string,
    {
      index: number; // SSE上のブロック番号
      name: string; // 関数名
      argsBuffer: string; // 引数を断片ごとに蓄積
      completed: boolean; // 完了済みフラグ
    }
  > = {};
  messageId: string;
  messageStarted = false;

  constructor() {
    this.messageId = uuid();
  }
}

/**
 * 型定義に沿ったSSEストリームライター
 * Honoの型定義に沿って、SSEイベントを生成して書き込む。
 */
class SSEWriter {
  constructor(private stream: SSEStreamingApi) {}

  private async write(event: ClaudeRawMessageStreamEvent) {
    const msg: SSEMessage = {
      event: event.type,
      data: JSON.stringify(event),
    };
    console.log(`[SSE] event="${msg.event}" data=${msg.data}`);
    await this.stream.writeSSE(msg);
  }

  /** メッセージ開始イベント （ID だけ渡す） */
  async messageStart(id: string) {
    const event: ClaudeRawMessageStartEvent = {
      type: "message_start",
      message: {
        type: "message",
        id,
        role: "assistant",
        content: [],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          input_tokens: 0,
          output_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    };
    await this.write(event);
  }

  /** テキストブロック開始 */
  async textStart(index: number) {
    const event: ClaudeRawContentBlockStartEvent = {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: [] },
    };
    await this.write(event);
  }

  /** テキストデルタ追加 */
  async deltaText(index: number, delta: string) {
    const event: ClaudeRawContentBlockDeltaEvent = {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: delta },
    };
    await this.write(event);
  }

  /** テキストブロック停止 */
  async textStop(index: number) {
    const event: ClaudeRawContentBlockStopEvent = {
      type: "content_block_stop",
      index,
    };
    await this.write(event);
  }

  /** ツール呼び出し開始 */
  async toolStart(
    index: number,
    item: { id: string; name: string; input?: unknown }
  ) {
    const event: ClaudeRawContentBlockStartEvent = {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: item.id,
        name: item.name,
        input: item.input ?? {},
      },
    };
    await this.write(event);
  }

  /** ツール引数デルタ */
  async toolArgsDelta(index: number, partialJson: string) {
    const event: ClaudeRawContentBlockDeltaEvent = {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partialJson },
    };
    await this.write(event);
  }

  /** ツールブロック停止 */
  async toolStop(index: number) {
    const event: ClaudeRawContentBlockStopEvent = {
      type: "content_block_stop",
      index,
    };
    await this.write(event);
  }

  /** メッセージ部分更新 */
  async messageDelta(
    delta: ClaudeRawMessageDeltaEvent["delta"],
    usage: ClaudeRawMessageDeltaEvent["usage"]
  ) {
    const event: ClaudeRawMessageDeltaEvent = {
      type: "message_delta",
      delta,
      usage,
    };
    await this.write(event);
  }

  /** メッセージ停止 */
  async messageStop() {
    const event: ClaudeRawMessageStopEvent = { type: "message_stop" };
    await this.write(event);
  }

  /** ping (型キャスト利用) */
  async ping() {
    const msg: SSEMessage = { data: "" };
    await this.stream.writeSSE(msg);
  }

  /** エラー報告 (型キャスト利用) */
  async error(_type: string, message: string) {
    const msg: SSEMessage = {
      data: JSON.stringify({ type: "error", error: { type: _type, message } }),
    };
    await this.stream.writeSSE(msg);
  }
}

// =============================================================================
// 変換関数
// =============================================================================

function convertClaudeImageToOpenAI(
  block: ClaudeContentBlockImage
): OpenAIResponseImageURLContentBlock {
  const src = block.source;
  if ("data" in src && "media_type" in src) {
    // ここでは src は Base64ImageSource として扱える
    return {
      type: "image_url" as const,
      image_url: {
        url: `data:${src.media_type};base64,${src.data}`,
      },
    };
  } else if ("url" in src) {
    // こっちは URLImageSource
    return {
      type: "image_url" as const,
      image_url: {
        url: src.url,
      },
    };
  } else {
    // 想定外のケースも保険
    throw new Error("Unsupported image source");
  }
}

function convertToolResult(
  block: ClaudeContentBlockToolResult
): OpenAIResponseFunctionToolCallOutputItem {
  console.log(
    `[DEBUG] tool_result: block.tool_use_id="${
      block.tool_use_id
    }", content=${JSON.stringify(block.content)}`
  );

  return {
    id: block.tool_use_id, // A準拠：元の ID をそのまま使う
    call_id: block.tool_use_id, // A準拠：元の ID をそのまま使う
    type: "function_call_output" as const,
    status: "completed",
    output:
      typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content),
  };
}

function convertClaudeMessage(
  message: ClaudeMessageParam
): OpenAIResponseInputItem[] {
  // ① 文字列だけのメッセージはそのまま返す
  if (typeof message.content === "string") {
    const inputMessage: OpenAIResponseEasyInputMessage = {
      role: message.role,
      content: message.content,
    };
    return [inputMessage];
  }

  const result: OpenAIResponseInputItem[] = [];
  let buffer: ClaudeTextBlock[] = [];

  for (const block of message.content) {
    switch (block.type) {
      case "text":
        // claude形式でバッファに溜める
        const text: ClaudeTextBlock = {
          type: "text",
          text: block.text,
          citations: [],
        };
        buffer.push(text);
        break;

      // 一旦コメントアウト
      // case "image":
      //   buffer.push(
      //     convertClaudeImageToOpenAI(block) as Responses.ResponseInputImage
      //   );
      //   break;

      case "tool_use":
        console.log(
          `[DEBUG] tool_use: block.id="${block.id}", block.name="${
            block.name
          }", input=${JSON.stringify(block.input)}`
        );
        flushBuffer();
        result.push({
          type: "function_call",
          id: block.id, // A準拠：元の ID をそのまま使う
          call_id: block.id, // A準拠：元の ID をそのまま使う
          name: block.name,
          arguments: JSON.stringify(block.input),
        } as OpenAIResponseFunctionToolCall);
        break;

      case "tool_result":
        flushBuffer();
        result.push(convertToolResult(block));
        break;
    }
  }
  flushBuffer();
  return result;

  // --- 内部関数 ---
  function flushBuffer() {
    if (buffer.length === 0) return;
    // buffer が「テキスト 1 個だけ」なら素の string に落としてサイズ節約
    if (buffer.length === 1 && "text" in buffer[0]) {
      result.push({
        role: message.role,
        content: buffer[0].text,
      });
    } else {
      const content: OpenAIResponseInputMessageContentList = buffer.map((b) => {
        // 必要がある場合は実装を追加
        switch (b.type) {
          case "text":
            // テキストブロックを OpenAI の形式に変換
            const textItem: OpenAIResponseInputText = {
              type: "input_text",
              text: b.text,
            };
            return textItem;
        }
      });

      result.push({
        role: message.role,
        content,
      });
    }
    buffer = [];
  }
}

// スキーマに required を再帰的に追加するヘルパー
function ensureRequiredRec(schema: any) {
  // オブジェクトレベルで required をマージ
  if (schema.type === "object" && typeof schema.properties === "object") {
    const props = Object.keys(schema.properties);
    const existing = Array.isArray(schema.required) ? schema.required : [];
    schema.required = Array.from(new Set([...existing, ...props]));
  }

  // 配列の要素スキーマにも再帰適用
  if (schema.type === "array" && schema.items) {
    ensureRequiredRec(schema.items);
  }

  // プロパティごとのネストも再帰
  if (typeof schema.properties === "object") {
    for (const key of Object.keys(schema.properties)) {
      ensureRequiredRec(schema.properties[key]);
    }
  }
}

// 再帰的に format:"uri" を削除するヘルパー
function removeUnsupportedFormats(schema: any) {
  if (schema.format === "uri") {
    delete schema.format;
  }
  // プロパティのネストも再帰
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      removeUnsupportedFormats(schema.properties[key]);
    }
  }
  // 配列アイテムのスキーマにも適用
  if (schema.items) {
    removeUnsupportedFormats(schema.items);
  }
}

// ① 既存のヘルパーに追加：additionalProperties を埋める
function ensureAdditionalPropertiesFalseRec(schema: any) {
  // オブジェクト型なら additionalProperties が無ければ false を追加
  if (schema.type === "object") {
    schema.additionalProperties = false;
  }
  // items や properties のネストにも再帰
  if (schema.items) {
    ensureAdditionalPropertiesFalseRec(schema.items);
  }
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      ensureAdditionalPropertiesFalseRec(schema.properties[key]);
    }
  }
}

// 型ガード：JSON-Schema を持つクライアントサイドツールかどうか
function isClientTool(t: ClaudeToolUnion): t is ClaudeTool {
  return "input_schema" in t;
}

// ClaudeリクエストをOpenAI Responses APIのパラメータに変換
function claudeToResponses(
  req: ClaudeMessageCreateParamsBase
): OpenAIResponses.ResponseCreateParams {
  // モデルマッピング
  const model: OpenAIResponseModel =
    modelMap[req.model] ?? DEFAULT_OPENAI_MODEL;

  // system → instructions
  const instructions = Array.isArray(req.system)
    ? req.system.map((b) => b.text).join("\n\n")
    : req.system ?? undefined;

  // messages → input (Claudeフォーマットを展開)
  const input: any[] = [];
  for (const message of req.messages) {
    input.push(...convertClaudeMessage(message));
  }

  // claudeToResponses 内の .map 部分に追加
  const toolsWithoutWebSearchPreview: OpenAITool[] | undefined = req.tools
    ? req.tools.flatMap<OpenAITool>((t) => {
        // tが ClaudeTool のインスタンスかどうかをチェック
        if (isClientTool(t)) {
          // クライアントサイドツール → JSON-Schema から関数定義を作成
          const schema = JSON.parse(JSON.stringify(t.input_schema));
          ensureRequiredRec(schema);
          removeUnsupportedFormats(schema);
          ensureAdditionalPropertiesFalseRec(schema);

          console.debug(
            `[DEBUG] tool ${t.name} → cleaned parameters=`,
            JSON.stringify(schema, null, 2)
          );

          return {
            type: "function",
            name: t.name,
            description: t.description ?? "",
            parameters: schema,
            strict: true,
          };
        } else {
          // 組み込みツール（bash, web_search, text_editor）を既存定義にマッピング
          switch (t.name) {
            case "bash":
              return bashFunction;
            case "web_search":
              return webSearchFunction;
            case "str_replace_editor":
            case "str_replace_based_edit_tool":
              return textEditorFunction;
            default:
              // 未対応ツールは無視
              return [];
          }
        }
      })
    : undefined;

  const tools: OpenAITool[] = [
    ...(toolsWithoutWebSearchPreview || []),
    webSearchPreviewFunction,
  ];

  // tool_choice マッピング
  let tool_choice: any = "auto";
  if (req.tool_choice?.type === "tool" && req.tool_choice.name) {
    tool_choice = {
      type: "function",
      function: { name: req.tool_choice.name },
    };
  } else if (req.tool_choice?.type === "any") {
    tool_choice = "required";
  }

  const baseParams: OpenAIResponseCreateParamsBase = {
    model,
    input,
    tools,
    tool_choice,
    // stop: req.stop_sequences,
  };

  // instructionsを追加（undefinedでない場合のみ）
  if (instructions) {
    baseParams.instructions = instructions;
  }

  // max_output_tokensを追加（OpenAI Responses APIの正しいパラメータ名）
  if (req.max_tokens) {
    baseParams.max_output_tokens = Math.max(req.max_tokens, 16384);
  }

  // temperatureとtop_pを追加（undefinedでない場合のみ）
  // if (req.temperature !== undefined) {
  //   baseParams.temperature = req.temperature;
  // }
  if (req.top_p !== undefined) {
    baseParams.top_p = req.top_p;
  }

  return baseParams;
}

function mapStopReason(reason: string): string {
  switch (reason) {
    case "stop":
    case "completed":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "function_call":
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

// =============================================================================
// イベントハンドラー
// =============================================================================

type OpenAIResponseItemIdStringEvent =
  | OpenAIResponseOutputItemAddedEvent
  | OpenAIResponseOutputItemDoneEvent;

// 型述語の定義
function isItemIdString(
  ev: OpenAIResponseItemIdStringEvent
): ev is OpenAIResponseItemIdStringEvent & { item: { id: string } } {
  return typeof ev.item.id === "string";
}

function handleResponsesEvent(
  ev: OpenAIResponseStreamEvent,
  state: StreamState,
  sse: SSEWriter
) {
  // usage情報を蓄積
  // if (ev.usage) {
  //   state.usage.input_tokens += ev.usage.input_tokens || 0;
  //   state.usage.output_tokens += ev.usage.output_tokens || 0;
  // }

  switch (ev.type) {
    // case "response.created":
    //   // メタ情報到着時にメッセージ開始を通知
    //   // sse.messageStart(state.messageId);
    //   // // 最初のテキストブロックをオープン
    //   // sse.textStart(state.textIndex);
    //   if (!state.messageStarted) {
    //     sse.messageStart(state.messageId); // ← 初回だけ
    //     sse.textStart(state.textIndex); // index = 0
    //     console.log("[DEBUG] messageStarted set to true");
    //     state.messageStarted = true;
    //   }
    //   break;
    // // ──────────────── 進捗通知（オプション） ────────────────
    // case "response.in_progress":
    //   // 必要ならハートビートなどを挟む
    //   break;

    case "response.created":
      // 完全に無視して何も出さない
      return;

    case "response.output_text.delta":
      sse.deltaText(state.textIndex, ev.delta);
      break;

    case "response.output_text.done":
      sse.textStop(state.textIndex);
      state.textIndex++;
      break;

    case "response.output_item.added":
      if (ev.item.type === "function_call" && isItemIdString(ev)) {
        // 既に start 済みなら重複をスキップ
        // 新しい call_id をステートに登録
        if (!state.toolCalls[ev.item.id]) {
          // A準拠：textIndexベースでインデックスずらし
          state.toolBlockCounter++;
          const claudeIndex = state.textIndex + state.toolBlockCounter;
          state.toolCalls[ev.item.id] = {
            index: claudeIndex,
            name: ev.item.name,
            argsBuffer: "",
            completed: false,
          };
          sse.toolStart(claudeIndex, { id: ev.item.id, name: ev.item.name });
        }
      }
      break;

    case "response.function_call_arguments.delta":
      // delta は必ず call_id が来るのでバッファに蓄積
      const call = state.toolCalls[ev.item_id];
      if (call && !call.completed) {
        call.argsBuffer += ev.delta;
        sse.toolArgsDelta(call.index, ev.delta);
      }
      break;

    case "response.output_item.done":
      // 関数呼び出しブロック完了
      if (ev.item.type === "function_call" && isItemIdString(ev)) {
        const call = state.toolCalls[ev.item.id];
        if (call && !call.completed) {
          // サーバーからまとめて来る arguments とバッファを比較・パース
          const fullArgs = JSON.parse(ev.item.arguments);
          // （任意）assert(call.argsBuffer === ev.item.arguments);
          // クライアント呼び出し実行→結果送信など後続処理をここで起動
          sse.toolStop(call.index);
          // ステートから除去
          delete state.toolCalls[ev.item.id];
        }
      }
      break;
    // case "response.output_item.done":
    //   if (!isItemIdString(ev)) {
    //     console.warn(
    //       "Received function_call without id; skipping until id is available."
    //     );
    //     break;
    //   }
    //   const doneTool_itemdone = state.toolCalls[ev.item.id];
    //   if (doneTool_itemdone) {
    //     sse.toolStop(doneTool_itemdone.index);
    //   }
    //   break;

    // case "response.stop":
    //   const stopReason = mapStopReason(ev.finish_reason || "stop");
    //   sse.messageDelta(stopReason, state.usage);
    //   sse.messageStop();
    //   break;

    // --- 追加すべきケース ---
    case "response.content_part.added":
    // Claude のコンテンツブロック（text/tool/etc.）開始時
    // state.textIndex++;
    // sse.textStart(state.textIndex); // または toolStart 等、適宜分岐
    case "response.content_part.done":
      // そのコンテンツブロックの終端
      // sse.textStop(state.textIndex); // または toolStop
      return;
    case "response.function_call_arguments.done":
      // 引数ストリーミングの最終断片到着
      const doneCall = state.toolCalls[ev.item_id];
      if (doneCall && !doneCall.completed) {
        doneCall.completed = true;
        sse.toolStop(doneCall.index);
      }
      break;

    // case "response.completed":
    //   sse.messageStop();
    //   // 次のレスポンスに備えてステートを初期化
    //   Object.assign(state, new StreamState());
    //   console.log(">>> completed: resetting state");
    //   state.messageStarted = false;
    //   break;

    case "response.completed":
      // --- A準拠の終了シーケンス ---
      // 1) 最後のテキストブロック停止
      sse.textStop(state.textIndex);

      // 2) すべての未停止ツールブロック停止
      Object.values(state.toolCalls).forEach((tc) => {
        if (!tc.completed) {
          sse.toolStop(tc.index);
        }
      });

      // 3) 停止理由＆usage を message_delta で通知
      // 3) stop_reason の決定
      let stopReason: "end_turn" | "max_tokens" | "tool_use";
      const status = ev.response.status; // 'completed' or 'incomplete'
      const detail = ev.response.incomplete_details?.reason;
      if (status === "incomplete" && detail === "max_output_tokens") {
        stopReason = "max_tokens";
      } else if (Object.keys(state.toolCalls).length > 0) {
        // ツール呼び出しが走っていたら
        stopReason = "tool_use";
      } else {
        stopReason = "end_turn";
      }

      // 4) 停止理由＆usage を通知
      sse.messageDelta(
        { stop_reason: stopReason, stop_sequence: null },
        {
          ...state.usage,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
        }
      );

      // 4) message_stop を送出
      sse.messageStop();

      // ステートをリセット
      Object.assign(state, new StreamState());
      break;

    // case "response.in_progress":
    //   // 必要ならハートビート的処理
    //   break;
    case "response.failed":
    case "response.incomplete":
    case "error":
      sse.error(ev.type, "Stream error");
      break;
    case "response.in_progress":
      // 例：ハートビート代わりに空の ping を送る
      sse.ping();
      // あるいは進捗率を含むカスタムイベントを返せるなら、
      // sse.write({ event: "progress", data: JSON.stringify({ percent: ev.percent }) });
      break;

    default:
      // 未知のイベントは無視
      console.warn("Unknown event type:", ev.type);
      break;
  }
}

// =============================================================================
// Honoアプリケーション
// =============================================================================

const app = new Hono();

// CORS設定
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  c.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );

  if (c.req.method === "OPTIONS") {
    return c.status(204); // 204 No Content for preflight requests
  }

  await next();
});

// ヘルスチェック
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (c) => {
  return c.text("Claude to OpenAI Responses API Proxy");
});

// メッセージエンドポイント
app.post("/v1/messages", async (c) => {
  console.log(
    "🟢 [Request] new /v1/messages stream=",
    c.req.query("stream"),
    " at ",
    new Date().toISOString()
  );
  try {
    const claudeReq = (await c.req.json()) as ClaudeMessageCreateParams;
    const openaiReq = claudeToResponses(claudeReq);

    // 非ストリーミングモード
    // if (!claudeReq.stream) {
    //   const response = await openai.responses.create({
    //     ...openaiReq,
    //     stream: false,
    //   });

    //   // TODO: OpenAI Response を Claude Response に変換
    //   return c.json(response);
    // }

    // ストリーミングモード
    return streamSSE(c, async (stream) => {
      const sse = new SSEWriter(stream);
      const state = new StreamState();

      // Ping タイマー設定
      const pingTimer = setInterval(() => {
        if (!stream.closed) {
          sse.ping();
        }
      }, 15000);

      console.log(
        "[DEBUG] OpenAI Request Params:\n",
        JSON.stringify(openaiReq, null, 2)
      );

      try {
        const openaiStream = await openai.responses.create({
          ...openaiReq,
          stream: true,
        });

        // ② ストリーム確立後、ここで最初の一回だけ開始イベントを送る
        if (!state.messageStarted) {
          sse.messageStart(state.messageId);
          sse.textStart(state.textIndex);
          sse.ping(); // 初回 ping も送る
          state.messageStarted = true;
        }

        for await (const event of openaiStream) {
          console.log("📨 [Stream Event]", event.type, event);
          handleResponsesEvent(event, state, sse);

          if (event.type === "response.completed") {
            console.log("✅ [Stream] response.completed → breaking loop");
            // ここを削除
            // sse.messageStop();
            break;
          }
          if (stream.closed) {
            console.log("🚪 [Stream] client closed connection");
            break;
          }
        }

        console.log("▶️ [Stream] loop exited, clearing ping timer");
      } catch (err) {
        console.error("🔥 [Stream Error]", err);
        sse.error("api_error", String(err));
      } finally {
        clearInterval(pingTimer);
      }
    });
  } catch (error) {
    console.error("Request processing error:", error);
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: String(error),
        },
      },
      400
    );
  }
});

// トークンカウントエンドポイント
app.post("/v1/messages/count_tokens", async (c) => {
  try {
    const claudeReq = (await c.req.json()) as ClaudeMessageCreateParams;

    // 簡易的なトークンカウント
    const encoder = encoding_for_model("gpt-4o-mini");

    let totalText = "";
    if (claudeReq.system) {
      totalText +=
        typeof claudeReq.system === "string"
          ? claudeReq.system
          : claudeReq.system.map((b) => b.text).join("\n");
    }

    for (const message of claudeReq.messages) {
      if (typeof message.content === "string") {
        totalText += message.content;
      } else {
        for (const block of message.content) {
          if (block.type === "text") {
            totalText += block.text;
          }
        }
      }
    }

    const tokens = encoder.encode(totalText).length;
    encoder.free();

    return c.json({ input_tokens: tokens });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

// テスト接続エンドポイント
app.get("/test-connection", async (c) => {
  try {
    // OpenAI APIの簡単なテスト
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: "Hello",
    });

    return c.json({
      status: "ok",
      openai_connected: true,
      test_response: response,
    });
  } catch (error) {
    return c.json(
      {
        status: "error",
        openai_connected: false,
        error: String(error),
      },
      500
    );
  }
});

export default app;
