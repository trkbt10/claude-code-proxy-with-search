import type { SSEMessage, SSEStreamingApi } from "hono/streaming";
import type {
  RawMessageStreamEvent,
  RawMessageStartEvent,
  RawMessageDeltaEvent,
  RawMessageStopEvent,
  RawContentBlockStartEvent,
  RawContentBlockDeltaEvent,
  RawContentBlockStopEvent,
} from "@anthropic-ai/sdk/resources/messages";

export class SSEWriter {
  constructor(private stream: SSEStreamingApi) {}

  private async write(event: RawMessageStreamEvent) {
    const msg: SSEMessage = {
      event: event.type,
      data: JSON.stringify(event),
    };
    console.log(`[SSE]`, JSON.stringify(event, null, 2));
    await this.stream.writeSSE(msg);
  }

  get closed(): boolean {
    return this.stream.closed;
  }

  async messageStart(id: string) {
    const event: RawMessageStartEvent = {
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

  async textStart(index: number) {
    const event: RawContentBlockStartEvent = {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: [] },
    };
    await this.write(event);
  }

  async deltaText(index: number, delta: string) {
    const event: RawContentBlockDeltaEvent = {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: delta },
    };
    await this.write(event);
  }

  async textStop(index: number) {
    const event: RawContentBlockStopEvent = {
      type: "content_block_stop",
      index,
    };
    await this.write(event);
  }

  async toolStart(
    index: number,
    item: { id: string; name: string; input?: unknown }
  ) {
    const event: RawContentBlockStartEvent = {
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

  async toolArgsDelta(index: number, partialJson: string) {
    const event: RawContentBlockDeltaEvent = {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partialJson },
    };
    await this.write(event);
  }

  async toolStop(index: number) {
    const event: RawContentBlockStopEvent = {
      type: "content_block_stop",
      index,
    };
    await this.write(event);
  }

  async messageDelta(
    delta: RawMessageDeltaEvent["delta"],
    usage: RawMessageDeltaEvent["usage"]
  ) {
    const event: RawMessageDeltaEvent = {
      type: "message_delta",
      delta,
      usage,
    };
    await this.write(event);
  }

  async messageStop() {
    const event: RawMessageStopEvent = { type: "message_stop" };
    await this.write(event);
  }

  async ping() {
    const msg: SSEMessage = { data: "" };
    await this.stream.writeSSE(msg);
  }

  async error(_type: string, message: string) {
    const msg: SSEMessage = {
      data: JSON.stringify({ type: "error", error: { type: _type, message } }),
    };
    await this.stream.writeSSE(msg);
  }
}
