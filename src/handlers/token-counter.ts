import { encoding_for_model } from "@dqbd/tiktoken";
import type { MessageCreateParams as ClaudeMessageCreateParams } from "@anthropic-ai/sdk/resources/messages";

export function countTokens(claudeReq: ClaudeMessageCreateParams): number {
  const encoder = encoding_for_model("gpt-4o-mini");

  let totalText = "";
  if (typeof claudeReq.system === "string") {
    totalText += claudeReq.system;
  }
  if (Array.isArray(claudeReq.system)) {
    totalText += claudeReq.system.map((b) => b.text).join("\n");
  }

  for (const message of claudeReq.messages) {
    if (typeof message.content === "string") {
      totalText += message.content;
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text") {
          totalText += block.text;
        }
      }
    }
  }

  const tokens = encoder.encode(totalText).length;
  encoder.free();

  return tokens;
}
