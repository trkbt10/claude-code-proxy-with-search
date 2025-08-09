import { Hono } from "hono";
import OpenAI from "openai";
import type { MessageCreateParams as ClaudeMessageCreateParams } from "@anthropic-ai/sdk/resources/messages";
import { countTokens } from "./handlers/token-counter";
import { checkEnvironmentVariables } from "./config/environment";
import { createResponseProcessor } from "./handlers/response-processor";

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
  return (
    err instanceof Error &&
    "status" in err &&
    typeof (err as Error & { status: unknown }).status === "number"
  );
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

  // Create and execute the appropriate processor
  const processor = createResponseProcessor({
    requestId,
    conversationId,
    openai,
    claudeReq,
    modelResolver: (model) => {
      return process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    },
    stream,
  });

  return processor.process(c);
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
    input: [
      {
        role: "user",
        content: "Hello",
      },
    ],
  });

  return c.json({
    status: "ok",
    openai_connected: true,
    test_response: response,
  });
});

export default app;
