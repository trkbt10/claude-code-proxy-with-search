import type {
  TextBlock as ClaudeTextBlock,
  MessageParam as ClaudeMessageParam,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  ResponseFunctionToolCall as OpenAIResponseFunctionToolCall,
  ResponseInputText as OpenAIResponseInputText,
  ResponseInputMessageContentList as OpenAIResponseInputMessageContentList,
  ResponseInputItem as OpenAIResponseInputItem,
  EasyInputMessage as OpenAIResponseEasyInputMessage,
} from "openai/resources/responses/responses";
import { convertClaudeImageToOpenAI } from "./image";
import { convertToolResult } from "./tool";

/**
 * Convert Claude message to OpenAI input items
 */
export function convertClaudeMessage(
  message: ClaudeMessageParam,
  callIdMapping?: Map<string, string>
): OpenAIResponseInputItem[] {
  console.log(
    `[DEBUG] Converting Claude message: role=${
      message.role
    }, content type=${typeof message.content}`
  );

  // Log the entire message for debugging
  console.log(
    `[DEBUG] Full message content:`,
    JSON.stringify(message.content, null, 2)
  );

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
        const text: ClaudeTextBlock = {
          type: "text",
          text: block.text,
          citations: [],
        };
        buffer.push(text);
        break;

      case "tool_use":
        console.log(
          `[DEBUG] Converting tool_use: id="${block.id}", name="${
            block.name
          }", input=${JSON.stringify(block.input)}`
        );
        flushBuffer();

        // Log the current mapping state
        if (callIdMapping) {
          console.log(
            `[DEBUG] Current call_id mappings for tool_use (${callIdMapping.size} entries):`,
            Array.from(callIdMapping.entries())
          );
        }

        // Find the call_id for this tool_use_id
        let callId: string | undefined;
        if (callIdMapping) {
          for (const [cid, tid] of callIdMapping.entries()) {
            if (tid === block.id) {
              callId = cid;
              break;
            }
          }
        }

        if (!callId) {
          console.warn(
            `[WARN] No call_id mapping found for tool_use_id: ${block.id}, using id as fallback`
          );
          // Use the tool_use_id as fallback - this happens when converting assistant messages
          // that haven't been through OpenAI yet
          callId = block.id;
        } else {
          console.log(
            `[DEBUG] Found call_id ${callId} for tool_use_id ${block.id}`
          );
        }

        // For function_call, we only need call_id, name, and arguments
        const toolCall: OpenAIResponseFunctionToolCall = {
          type: "function_call",
          call_id: callId,
          name: block.name,
          arguments: JSON.stringify(block.input),
        };
        result.push(toolCall);
        console.log(
          `[DEBUG] Created function_call with call_id="${toolCall.call_id}"`
        );
        break;

      case "tool_result":
        flushBuffer();
        const toolResult = convertToolResult(block, callIdMapping);
        result.push(toolResult);

        // Validate that we have a corresponding tool call
        console.log(
          `[DEBUG] Added tool_result for call_id="${toolResult.call_id}"`
        );
        break;

      case "image": {
        // Handle image blocks
        flushBuffer();
        const imageContent = convertClaudeImageToOpenAI(block);
        result.push({
          role: message.role,
          content: [imageContent],
        });
        break;
      }
    }
  }
  flushBuffer();
  return result;

  function flushBuffer() {
    if (buffer.length === 0) {
      // If there's no text content but we're flushing (e.g., before a tool call),
      // we should NOT add an empty message
      return;
    }
    if (buffer.length === 1 && "text" in buffer[0]) {
      result.push({
        role: message.role,
        content: buffer[0].text,
      });
    } else {
      // For assistant messages, we just push them as simple text
      if (message.role === "assistant") {
        const textContent = buffer.map((b) => b.text).join("");
        result.push({
          role: message.role,
          content: textContent,
        });
      } else {
        // For user messages, we use the content array format
        const content: OpenAIResponseInputMessageContentList = buffer.map(
          (b) => {
            switch (b.type) {
              case "text":
                const inputTextItem: OpenAIResponseInputText = {
                  type: "input_text",
                  text: b.text,
                };
                return inputTextItem;
            }
          }
        );

        result.push({
          role: message.role,
          content,
        });
      }
    }
    buffer = [];
  }
}