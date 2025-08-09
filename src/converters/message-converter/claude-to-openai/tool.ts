import type {
  ToolResultBlockParam as ClaudeContentBlockToolResult,
  Tool as ClaudeTool,
  ToolUnion as ClaudeToolUnion,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  ResponseFunctionToolCallOutputItem as OpenAIResponseFunctionToolCallOutputItem,
  Tool as OpenAITool,
} from "openai/resources/responses/responses";
import {
  bashFunction,
  webSearchFunction,
  textEditorFunction,
} from "../../../tools/definitions";
import { normalizeJSONSchemaForOpenAI } from "../../schema-helpers";

/**
 * Convert tool result from Claude format to OpenAI format
 */
export function convertToolResult(
  block: ClaudeContentBlockToolResult,
  callIdMapping?: Map<string, string>
): OpenAIResponseFunctionToolCallOutputItem {
  console.log(
    `[DEBUG] Converting tool_result: tool_use_id="${
      block.tool_use_id
    }", content=${JSON.stringify(block.content)}`
  );

  // Log the current mapping state
  if (callIdMapping) {
    console.log(
      `[DEBUG] Current call_id mappings (${callIdMapping.size} entries):`,
      Array.from(callIdMapping.entries())
    );
  } else {
    console.log("[DEBUG] No call_id mapping provided");
  }

  // Find the call_id for this tool_use_id
  let call_id: string | undefined;
  if (callIdMapping) {
    for (const [cid, tid] of callIdMapping.entries()) {
      if (tid === block.tool_use_id) {
        call_id = cid;
        break;
      }
    }
  }

  if (!call_id) {
    console.error(
      `[ERROR] No call_id mapping found for tool_use_id: ${block.tool_use_id}`
    );
    // Don't throw error, just use the tool_use_id as fallback
    // This might happen in the first request when mapping isn't established yet
    console.warn(
      `[WARN] Using tool_use_id as fallback call_id: ${block.tool_use_id}`
    );
    call_id = block.tool_use_id;
  } else {
    console.log(
      `[DEBUG] Found call_id ${call_id} for tool_use_id ${block.tool_use_id}`
    );
  }

  // Return with id, type, call_id and output as per OpenAI ResponseFunctionToolCallOutputItem type
  return {
    id: block.tool_use_id, // Use tool_use_id as the id
    type: "function_call_output",
    call_id: call_id,
    output:
      typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content),
  };
}

/**
 * Check if tool is a client tool
 */
function isClientTool(t: ClaudeToolUnion): t is ClaudeTool {
  return "input_schema" in t;
}

/**
 * Convert Claude tool to OpenAI tool format
 */
export function convertClaudeToolToOpenAI(
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
        console.warn(t, "[WARN] Unknown tool type, returning empty array");
    }
    return [];
  }
}