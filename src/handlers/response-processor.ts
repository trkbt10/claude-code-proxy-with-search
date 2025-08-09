import OpenAI from "openai";
import type {
  ResponseCreateParams,
  Response as OpenAIResponse,
} from "openai/resources/responses/responses";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { MessageCreateParams as ClaudeMessageCreateParams } from "@anthropic-ai/sdk/resources/messages";
import { streamingPipelineFactory } from "../utils/streaming/streaming-pipeline";
import { convertOpenAIResponseToClaude } from "../converters/openai-to-claude";
import { conversationStore } from "../utils/conversation/conversation-store";
import { claudeToResponses } from "../converters/request-converter";

export type ProcessorConfig = {
  requestId: string;
  conversationId: string;
  openai: OpenAI;
  claudeReq: ClaudeMessageCreateParams;
  modelResolver: (model: any) => string;
  stream: boolean;
};

export type ProcessorResult = {
  responseId?: string;
  callIdMapping?: Map<string, string>;
};

function handleError(requestId: string, openaiReq: ResponseCreateParams, error: unknown): void {
  console.error(`[Request ${requestId}] Error:`, error);

  if (
    error instanceof Error &&
    "status" in error &&
    (error as any).status === 400 &&
    error.message?.includes("No tool output found")
  ) {
    console.error(
      `[Request ${requestId}] Tool result error - the conversation history might be incomplete`
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
}

async function processNonStreamingResponse(
  config: ProcessorConfig,
  openaiReq: ResponseCreateParams,
  c: Context
): Promise<Response> {
  try {
    const response = await config.openai.responses.create({
      ...openaiReq,
      stream: false,
    });

    const { message: claudeResponse, callIdMapping } =
      convertOpenAIResponseToClaude(response);

    conversationStore.updateConversationState({
      conversationId: config.conversationId,
      requestId: config.requestId,
      responseId: response.id,
      callIdMapping,
    });

    return c.json(claudeResponse);
  } catch (error) {
    handleError(config.requestId, openaiReq, error);
    throw error;
  }
}

async function processStreamingResponse(
  config: ProcessorConfig,
  openaiReq: ResponseCreateParams,
  c: Context
): Promise<Response> {
  return streamSSE(c, async (stream) => {
    const pipeline = streamingPipelineFactory.create(stream, {
      requestId: config.requestId,
      logEnabled: process.env.LOG_EVENTS === "true",
    });

    console.log(
      `[Request ${config.requestId}] OpenAI Request Params:\n`,
      JSON.stringify(openaiReq, null, 2)
    );

    try {
      const openaiStream = await config.openai.responses
        .create({
          ...openaiReq,
          stream: true,
        })
        .catch(async (error) => {
          handleError(config.requestId, openaiReq, error);
          throw error;
        });

      await pipeline.start();

      for await (const event of openaiStream) {
        await pipeline.processEvent(event);

        if (pipeline.isCompleted()) {
          console.log(
            `✅ [Request ${config.requestId}] response.completed → breaking loop`
          );
          break;
        }
        if (pipeline.isClientClosed()) {
          console.log(
            `🚪 [Request ${config.requestId}] client closed connection`
          );
          break;
        }
      }

      console.log(
        `▶️ [Request ${config.requestId}] loop exited`
      );

      const result = pipeline.getResult();
      conversationStore.updateConversationState({
        conversationId: config.conversationId,
        requestId: config.requestId,
        responseId: result.responseId,
        callIdMapping: result.callIdMapping,
      });
    } catch (err) {
      await pipeline.handleError(err);
    } finally {
      streamingPipelineFactory.release(config.requestId);
      console.log(`[Request ${config.requestId}] Cleanup complete`);
    }
  });
}

export const createResponseProcessor = (config: ProcessorConfig) => {
  // Get conversation context
  const context = conversationStore.getConversationContext(config.conversationId);

  // Log existing call_id mapping from context
  if (context.callIdMapping && context.callIdMapping.size > 0) {
    console.log(
      `[Request ${config.requestId}] Existing call_id mappings from context:`,
      Array.from(context.callIdMapping.entries())
    );
  }

  // Convert Claude request to OpenAI format
  const openaiReq = claudeToResponses(
    config.claudeReq,
    config.modelResolver,
    context.lastResponseId,
    context.callIdMapping
  );

  if (context.lastResponseId) {
    console.log(
      `[Request ${config.requestId}] Using previous_response_id: ${context.lastResponseId}`
    );
  }

  // Return the processor function
  return {
    process: (c: Context): Promise<Response> => {
      return config.stream
        ? processStreamingResponse(config, openaiReq, c)
        : processNonStreamingResponse(config, openaiReq, c);
    },
  };
};