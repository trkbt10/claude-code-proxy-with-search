import type {
  TextBlock as ClaudeTextBlock,
  ImageBlockParam as ClaudeContentBlockImage,
  ToolResultBlockParam as ClaudeContentBlockToolResult,
  MessageParam as ClaudeMessageParam,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  ResponseFunctionToolCall as OpenAIResponseFunctionToolCall,
  ResponseFunctionToolCallOutputItem as OpenAIResponseFunctionToolCallOutputItem,
  ResponseInputText as OpenAIResponseInputText,
  ResponseOutputText as OpenAIResponseOutputText,
  ResponseInputMessageContentList as OpenAIResponseInputMessageContentList,
  ResponseInputItem as OpenAIResponseInputItem,
  EasyInputMessage as OpenAIResponseEasyInputMessage,
} from "openai/resources/responses/responses";
import type { ResponseInputImage } from "openai/resources/responses/responses";

function isBase64ImageSource(
  source: any
): source is { type: "base64"; data: string; media_type: string } {
  return (
    source &&
    source.type === "base64" &&
    "data" in source &&
    "media_type" in source
  );
}

function isURLImageSource(source: any): source is { type: "url"; url: string } {
  return source && source.type === "url" && "url" in source;
}

export function convertClaudeImageToOpenAI(
  block: ClaudeContentBlockImage
): ResponseInputImage {
  const src = block.source;

  if (isBase64ImageSource(src)) {
    return {
      type: "input_image" as const,
      image_url: `data:${src.media_type};base64,${src.data}`,
      detail: "auto",
    };
  }

  if (isURLImageSource(src)) {
    return {
      type: "input_image" as const,
      image_url: src.url,
      detail: "auto",
    };
  }

  throw new Error("Unsupported image source");
}

export function convertToolResult(
  block: ClaudeContentBlockToolResult,
  callIdMapping?: Map<string, string>
): OpenAIResponseFunctionToolCallOutputItem {
  console.log(
    `[DEBUG] Converting tool_result: tool_use_id="${
      block.tool_use_id
    }", content=${JSON.stringify(block.content)}`
  );

  // Check if we have a mapped call_id for this tool_use_id
  let call_id = block.tool_use_id;
  if (callIdMapping) {
    // Look for a call_id that maps to this tool_use_id
    for (const [openaiCallId, claudeToolId] of callIdMapping.entries()) {
      if (claudeToolId === block.tool_use_id) {
        call_id = openaiCallId;
        console.log(
          `[DEBUG] Found call_id mapping: ${block.tool_use_id} -> ${call_id}`
        );
        break;
      }
    }
  }

  return {
    id: block.tool_use_id,
    call_id: call_id, // Use the mapped call_id if available
    type: "function_call_output" as const,
    status: "completed",
    output:
      typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content),
  };
}

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
        const toolCall: OpenAIResponseFunctionToolCall = {
          type: "function_call",
          id: block.id,
          call_id: block.id, // This call_id must match in tool results
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
      const content: OpenAIResponseInputMessageContentList = buffer.map((b) => {
        switch (b.type) {
          case "text":
            if (message.role === "assistant") {
              const outputTextItem: OpenAIResponseOutputText = {
                type: "output_text",
                text: b.text,
              };
              return outputTextItem;
            } else {
              const inputTextItem: OpenAIResponseInputText = {
                type: "input_text",
                text: b.text,
              };
              return inputTextItem;
            }
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
