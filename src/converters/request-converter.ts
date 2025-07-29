import type {
  Tool as ClaudeTool,
  ToolUnion as ClaudeToolUnion,
  MessageCreateParamsBase as ClaudeMessageCreateParamsBase,
  Model as ClaudeModel,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  Responses as OpenAIResponses,
  Tool as OpenAITool,
  ResponseCreateParamsBase as OpenAIResponseCreateParamsBase,
} from "openai/resources/responses/responses";
import type { ResponsesModel as OpenAIResponseModel } from "openai/resources/shared";
import { convertClaudeMessage } from "./claude-to-openai";
import {
  bashFunction,
  webSearchFunction,
  textEditorFunction,
  webSearchPreviewFunction,
} from "../tools/definitions";
import { normalizeJSONSchemaForOpenAI } from "./schema-helpers";

export const DEFAULT_OPENAI_MODEL: OpenAIResponseModel =
  (process.env.OPENAI_MODEL as OpenAIResponseModel) || "gpt-4.1";

export const modelMap: Partial<Record<ClaudeModel, OpenAIResponseModel>> = {
  "claude-3-5-sonnet-20241022": DEFAULT_OPENAI_MODEL,
  "claude-3-5-haiku-20241022": DEFAULT_OPENAI_MODEL,
  "claude-3-sonnet-20240229": DEFAULT_OPENAI_MODEL,
  "claude-3-haiku-20240307": DEFAULT_OPENAI_MODEL,
  "claude-3-opus-20240229": DEFAULT_OPENAI_MODEL,
};

function isClientTool(t: ClaudeToolUnion): t is ClaudeTool {
  return "input_schema" in t;
}

function convertClaudeToolToOpenAI(
  t: ClaudeToolUnion
): OpenAITool | OpenAITool[] {
  if (isClientTool(t)) {
    const schema = normalizeJSONSchemaForOpenAI(t.input_schema);

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
    switch (t.name) {
      case "bash":
        return bashFunction;
      case "web_search":
        return webSearchFunction;
      case "str_replace_editor":
      case "str_replace_based_edit_tool":
        return textEditorFunction;
      default:
        return [];
    }
  }
}

export function claudeToResponses(
  req: ClaudeMessageCreateParamsBase,
  previousResponseId?: string
): OpenAIResponses.ResponseCreateParams {
  const model: OpenAIResponseModel =
    modelMap[req.model] ?? DEFAULT_OPENAI_MODEL;
  const instructions = Array.isArray(req.system)
    ? req.system.map((b) => b.text).join("\n\n")
    : req.system ?? undefined;

  const input: OpenAIResponses.ResponseInputItem[] = [];
  
  // Process all messages to build the full conversation context
  // The Responses API needs the complete conversation history in each request
  const toolCalls = new Set<string>();
  const toolResults = new Set<string>();
  
  for (const message of req.messages) {
    const convertedItems = convertClaudeMessage(message);
    input.push(...convertedItems);
    
    // Track tool calls and results for validation
    for (const item of convertedItems) {
      if (item.type === "function_call" && "call_id" in item) {
        toolCalls.add(item.call_id);
      } else if (item.type === "function_call_output" && "call_id" in item) {
        toolResults.add(item.call_id);
      }
    }
    
    // Log for debugging
    console.log(
      `[DEBUG] Converted ${message.role} message to ${convertedItems.length} items`
    );
  }
  
  // Validate that all tool results have corresponding calls
  for (const resultId of toolResults) {
    if (!toolCalls.has(resultId)) {
      console.error(
        `[ERROR] Tool result with call_id="${resultId}" has no corresponding tool call in conversation history!`
      );
    }
  }

  const toolsWithoutWebSearchPreview: OpenAITool[] | undefined = req.tools
    ? req.tools.flatMap<OpenAITool>(convertClaudeToolToOpenAI)
    : undefined;

  const tools: OpenAITool[] = [
    ...(toolsWithoutWebSearchPreview || []),
    webSearchPreviewFunction,
  ];

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
  };

  if (instructions) {
    baseParams.instructions = instructions;
  }

  if (req.max_tokens) {
    baseParams.max_output_tokens = Math.max(req.max_tokens, 16384);
  }

  if (req.top_p !== undefined) {
    baseParams.top_p = req.top_p;
  }

  // Add previous response ID if provided
  if (previousResponseId) {
    baseParams.previous_response_id = previousResponseId;
  }

  return baseParams;
}
