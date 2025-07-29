import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import type { MessageCreateParams as ClaudeMessageCreateParams } from "@anthropic-ai/sdk/resources/messages";
import type {
  Message as ClaudeMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages";
import { streamStateManager } from "./utils/stream-state-manager";
import { SSEWriter } from "./utils/sse-writer";
import { claudeToResponses } from "./converters/request-converter";
import { convertOpenAIResponseToClaude } from "./converters/openai-to-claude";
import { countTokens } from "./handlers/token-counter";
import { checkEnvironmentVariables } from "./config/environment";
import { conversationStore } from "./utils/conversation-store";

checkEnvironmentVariables();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  defaultHeaders: {
    "OpenAI-Beta": "responses-2025-06-21",
  },
});

const app = new Hono();

// Type guard for error with status
function isErrorWithStatus(err: unknown): err is Error & { status: number } {
  return err instanceof Error && "status" in err && typeof (err as Error & { status: unknown }).status === "number";
}

// グローバルエラーハンドラー
app.onError((err, c) => {
  console.error("Global error handler:", err);
  const status = isErrorWithStatus(err) ? err.status : 500;
  return c.json(
    {
      type: "error",
      error: {
        type: "api_error",
        message: err.message || "Internal server error",
      },
    },
    status as Parameters<typeof c.json>[1]
  );
});

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
  const requestId = Math.random().toString(36).substring(7);
  const steinlessHelperMethod = c.req.header("x-stainless-helper-method");
  const stream = steinlessHelperMethod === "stream";
  console.log(`
    🟢 [Request ${requestId}] new /v1/messages stream=${stream} at ${new Date().toISOString()}`);

  const claudeReq = (await c.req.json()) as ClaudeMessageCreateParams;

  // Extract conversation ID from headers or generate one
  const conversationId =
    c.req.header("x-conversation-id") ||
    c.req.header("x-session-id") ||
    requestId; // Use request ID as fallback

  // Log the incoming Claude request to understand the flow
  console.log(
    `[Request ${requestId}] Incoming Claude Request (conversation: ${conversationId}):`,
    JSON.stringify(claudeReq, null, 2)
  );

  // Get conversation context
  const context = conversationStore.getOrCreate(conversationId);

  // Pass previous response ID and call_id mapping to the converter
  const openaiReq = claudeToResponses(claudeReq, context.lastResponseId, context.callIdMapping);

  if (context.lastResponseId) {
    console.log(
      `[Request ${requestId}] Using previous_response_id: ${context.lastResponseId}`
    );
  }
  // 非ストリーミングモード
  if (!stream) {
    try {
      const response = await openai.responses.create({
        ...openaiReq,
        stream: false,
      });

      // Store the response ID for future requests
      if (response.id) {
        conversationStore.update(conversationId, {
          lastResponseId: response.id,
        });
        console.log(
          `[Request ${requestId}] Stored response ID: ${response.id}`
        );
      }

      const { message: claudeResponse, callIdMapping } = convertOpenAIResponseToClaude(response);
      
      // Store call_id mapping for future requests
      if (callIdMapping.size > 0) {
        console.log(`[Request ${requestId}] Storing call_id mappings:`, Array.from(callIdMapping.entries()));
        conversationStore.update(conversationId, { callIdMapping });
      }
      
      return c.json(claudeResponse);
    } catch (error: any) {
      console.error(`[Request ${requestId}] Non-streaming error:`, error);

      if (
        error.status === 400 &&
        error.message?.includes("No tool output found")
      ) {
        console.error(
          `[Request ${requestId}] Tool result error in non-streaming mode`
        );
        console.error(
          `[Request ${requestId}] Request details:`,
          JSON.stringify(
            { tools: openaiReq.tools?.length, input: openaiReq.input },
            null,
            2
          )
        );
      }

      throw error;
    }
  }

  // ストリーミングモード
  return streamSSE(c, async (stream) => {
    const sse = new SSEWriter(stream);
    const state = streamStateManager.createStream(requestId, sse);

    // Ping タイマー開始
    state.startPingTimer();

    console.log(
      `[Request ${requestId}] OpenAI Request Params:\n`,
      JSON.stringify(openaiReq, null, 2)
    );

    try {
      const openaiStream = await openai.responses
        .create({
          ...openaiReq,
          stream: true,
        })
        .catch(async (error) => {
          // Handle OpenAI API errors
          console.error(`[Request ${requestId}] OpenAI API Error:`, error);

          if (
            error.status === 400 &&
            error.message?.includes("No tool output found")
          ) {
            console.error(
              `[Request ${requestId}] Tool result error - the conversation history might be incomplete`
            );
            console.error(
              `[Request ${requestId}] Input items:`,
              JSON.stringify(openaiReq.input, null, 2)
            );
          }

          throw error;
        });

      // ② ストリーム確立後、ここで最初の一回だけ開始イベントを送る
      await state.greeting();

      for await (const event of openaiStream) {
        await state.handleEvent(event);

        if (event.type === "response.completed") {
          console.log(
            `✅ [Request ${requestId}] response.completed → breaking loop`
          );
          // ここを削除
          // sse.messageStop();
          break;
        }
        if (stream.closed) {
          console.log(`🚪 [Request ${requestId}] client closed connection`);
          break;
        }
      }

      console.log(`▶️ [Request ${requestId}] loop exited, stopping ping timer`);

      // Store the response ID and call_id mapping for future requests
      const responseId = state.getResponseId();
      const callIdMapping = state.getCallIdMapping();
      
      const updates: any = {};
      if (responseId) {
        updates.lastResponseId = responseId;
        console.log(
          `[Request ${requestId}] Stored streaming response ID: ${responseId}`
        );
      }
      
      if (callIdMapping.size > 0) {
        updates.callIdMapping = callIdMapping;
        console.log(
          `[Request ${requestId}] Stored streaming call_id mappings:`, 
          Array.from(callIdMapping.entries())
        );
      }
      
      if (Object.keys(updates).length > 0) {
        conversationStore.update(conversationId, updates);
      }
    } catch (err) {
      console.error(`🔥 [Request ${requestId}] Stream Error`, err);
      sse.error("api_error", String(err));
    } finally {
      streamStateManager.releaseStream(requestId);
      console.log(`[Request ${requestId}] Cleanup complete`);
    }
  });
});

// トークンカウントエンドポイント
app.post("/v1/messages/count_tokens", async (c) => {
  const claudeReq = (await c.req.json()) as ClaudeMessageCreateParams;
  const tokens = countTokens(claudeReq);
  return c.json({ input_tokens: tokens });
});

// テスト接続エンドポイント
app.get("/test-connection", async (c) => {
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
});

export default app;
