import { randomUUID } from "node:crypto";
import type { SSEWriter } from "./sse-writer";
import { EventLogger } from "./logger";
import { ContentBlockManager } from "./content-block-manager";
import type {
  ResponseStreamEvent as OpenAIResponseStreamEvent,
  ResponseOutputItemAddedEvent as OpenAIResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent as OpenAIResponseOutputItemDoneEvent,
  ResponseWebSearchCallInProgressEvent,
  ResponseWebSearchCallSearchingEvent,
  ResponseWebSearchCallCompletedEvent,
  ResponseCreatedEvent,
  ResponseContentPartAddedEvent,
  ResponseContentPartDoneEvent,
} from "openai/resources/responses/responses";

export class StreamState {
  private usage = { input_tokens: 0, output_tokens: 0 };
  private contentManager = new ContentBlockManager();
  private messageId: string;
  private messageStarted = false;
  private responseId?: string;
  private pingTimer?: NodeJS.Timeout;
  private logger: EventLogger;
  private streamCompleted = false;
  private currentTextBlockId?: string;
  private callIdMapping: Map<string, string> = new Map(); // Maps OpenAI call_id to Claude tool_use_id

  constructor(
    private sse: SSEWriter,
    logEnabled: boolean = process.env.LOG_EVENTS === "true"
  ) {
    this.messageId = randomUUID();
    this.logger = new EventLogger(process.env.LOG_DIR || "./logs", logEnabled);
  }

  async greeting() {
    if (!this.messageStarted) {
      await this.sse.messageStart(this.messageId);
      await this.sse.ping();
      this.messageStarted = true;
    }
  }

  startPingTimer(intervalMs: number = 15000) {
    this.pingTimer = setInterval(() => {
      if (!this.sse.closed) {
        this.sse.ping();
      }
    }, intervalMs);
  }

  cleanup() {
    // Stop ping timer
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    // Future cleanup tasks can be added here
  }

  async handleEvent(ev: OpenAIResponseStreamEvent) {
    // Ignore events after stream is completed
    if (this.streamCompleted) {
      console.warn(
        "[StreamState] Ignoring event after stream completed:",
        ev.type
      );
      return;
    }

    this.logger.log("stream_event", ev);

    switch (ev.type) {
      case "response.created":
        // Capture the response ID for future requests
        const createdEvent = ev as ResponseCreatedEvent;
        if (createdEvent.response?.id) {
          this.responseId = createdEvent.response.id;
          console.log(`[StreamState] Captured response ID: ${this.responseId}`);
        }
        const { block: textBlock, metadata: textMeta } = this.contentManager.addTextBlock();
        this.currentTextBlockId = textMeta.id;
        await this.sse.textStart(textMeta.index);
        this.contentManager.markStarted(textMeta.id);
        return;

      case "response.output_text.delta":
        const currentBlockResult = this.currentTextBlockId
          ? this.contentManager.getBlock(this.currentTextBlockId)
          : this.contentManager.getCurrentTextBlock();
        if (currentBlockResult) {
          await this.sse.deltaText(currentBlockResult.metadata.index, ev.delta);
          this.contentManager.updateTextContent(currentBlockResult.metadata.id, ev.delta);
        }
        break;

      case "response.output_text.done":
        const doneBlockResult = this.currentTextBlockId
          ? this.contentManager.getBlock(this.currentTextBlockId)
          : this.contentManager.getCurrentTextBlock();
        if (doneBlockResult) {
          await this.sse.textStop(doneBlockResult.metadata.index);
          this.contentManager.markCompleted(doneBlockResult.metadata.id);
        }
        this.currentTextBlockId = undefined;
        break;

      case "response.output_item.added":
        if (ev.item.type === "function_call" && this.isItemIdString(ev)) {
          console.log(`[StreamState] function_call event:`, {
            id: ev.item.id,
            call_id: ev.item.call_id,
            name: ev.item.name,
            type: ev.item.type
          });
          
          const { block: toolBlock, metadata: toolMeta } = this.contentManager.addToolBlock(
            ev.item.id,
            ev.item.name,
            ev.item.call_id
          );
          
          // Store the mapping from call_id to tool_use_id
          if (ev.item.call_id) {
            this.callIdMapping.set(ev.item.call_id, ev.item.id);
            console.log(`[StreamState] Stored mapping: call_id ${ev.item.call_id} -> tool_use_id ${ev.item.id}`);
          }
          
          if (!toolMeta.started) {
            await this.sse.toolStart(toolMeta.index, {
              id: ev.item.id,
              name: ev.item.name,
            });
            this.contentManager.markStarted(toolMeta.id);
          }
        }
        break;

      case "response.function_call_arguments.delta":
        const toolBlockResult = this.contentManager.getToolBlock(ev.item_id);
        if (toolBlockResult && !toolBlockResult.metadata.completed) {
          toolBlockResult.metadata.argsBuffer = (toolBlockResult.metadata.argsBuffer || "") + ev.delta;
          await this.sse.toolArgsDelta(toolBlockResult.metadata.index, ev.delta);
        }
        break;

      case "response.output_item.done":
        if (ev.item.type === "function_call" && this.isItemIdString(ev)) {
          const toolBlockResult = this.contentManager.getToolBlock(ev.item.id);
          if (toolBlockResult && !toolBlockResult.metadata.completed) {
            await this.sse.toolStop(toolBlockResult.metadata.index);
            this.contentManager.markCompleted(toolBlockResult.metadata.id);
          }
        }
        break;

      case "response.content_part.added":
        // Content parts are complete content items (not deltas)
        // They seem to be sent in addition to the delta events
        // Log for now to understand the flow better
        const contentAddedEvent = ev as ResponseContentPartAddedEvent;
        console.log(
          `[StreamState] content_part.added: type=${contentAddedEvent.part.type}, ` +
            `item_id=${contentAddedEvent.item_id}, content_index=${contentAddedEvent.content_index}`
        );
        console.log(contentAddedEvent);
        if (contentAddedEvent.item_id) {
          this.responseId = contentAddedEvent.item_id;
          console.log(`[StreamState] Captured response ID: ${this.responseId}`);
        }
        const { block: newTextBlock, metadata: newTextMeta } = this.contentManager.addTextBlock();
        this.currentTextBlockId = newTextMeta.id;
        await this.sse.textStart(newTextMeta.index);
        this.contentManager.markStarted(newTextMeta.id);
        if (contentAddedEvent.part.type === "output_text") {
          await this.sse.deltaText(
            newTextMeta.index,
            contentAddedEvent.part.text
          );
          this.contentManager.updateTextContent(newTextMeta.id, contentAddedEvent.part.text);
        }

        break;

      case "response.content_part.done": {
        // Log to understand the flow
        const contentDoneEvent = ev as ResponseContentPartDoneEvent;
        console.log(
          `[StreamState] content_part.done: type=${contentDoneEvent.part.type}, ` +
            `item_id=${contentDoneEvent.item_id}, content_index=${contentDoneEvent.content_index}`
        );
        console.log(contentDoneEvent);
        const textBlockResult = this.currentTextBlockId
          ? this.contentManager.getBlock(this.currentTextBlockId)
          : this.contentManager.getCurrentTextBlock();
        if (textBlockResult) {
          if (contentDoneEvent.part.type === "output_text") {
            await this.sse.deltaText(
              textBlockResult.metadata.index,
              contentDoneEvent.part.text
            );
            this.contentManager.updateTextContent(textBlockResult.metadata.id, contentDoneEvent.part.text);
          }
          await this.sse.textStop(textBlockResult.metadata.index);
          this.contentManager.markCompleted(textBlockResult.metadata.id);
        }
        this.currentTextBlockId = undefined;
        break;
      }

      case "response.function_call_arguments.done":
        const doneToolBlockResult = this.contentManager.getToolBlock(ev.item_id);
        if (doneToolBlockResult && !doneToolBlockResult.metadata.completed) {
          // Don't mark as completed here - wait for output_item.done
          console.log(
            `[StreamState] Tool args done for: ${doneToolBlockResult.block.name}`
          );
        }
        break;

      case "response.completed":
        // Stop any uncompleted blocks
        const uncompletedBlocks = this.contentManager.getUncompletedBlocks();
        for (const { block, metadata } of uncompletedBlocks) {
          if (block.type === "text") {
            await this.sse.textStop(metadata.index);
          } else if (block.type === "tool_use") {
            await this.sse.toolStop(metadata.index);
          }
          this.contentManager.markCompleted(metadata.id);
        }

        const hasActiveTool = this.contentManager.hasActiveTools();
        let stopReason: "end_turn" | "max_tokens" | "tool_use";
        const status = ev.response.status;
        const detail = ev.response.incomplete_details?.reason;
        if (status === "incomplete" && detail === "max_output_tokens") {
          stopReason = "max_tokens";
        } else if (hasActiveTool) {
          stopReason = "tool_use";
        } else {
          stopReason = "end_turn";
        }

        this.sse.messageDelta(
          { stop_reason: stopReason, stop_sequence: null },
          {
            ...this.usage,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
          }
        );

        this.sse.messageStop();
        this.streamCompleted = true;
        break;

      case "response.failed":
      case "response.incomplete":
      case "error":
        this.sse.error(ev.type, "Stream error");
        break;

      case "response.in_progress":
        this.sse.ping();
        break;

      case "response.web_search_call.in_progress":
        const webSearchInProgress = ev as ResponseWebSearchCallInProgressEvent;
        // Web検索開始をツールブロックとして送信
        const { block: webSearchBlock, metadata: webSearchMeta } = this.contentManager.addToolBlock(
          webSearchInProgress.item_id,
          "web_search"
        );
        if (!webSearchMeta.started) {
          await this.sse.toolStart(webSearchMeta.index, {
            id: webSearchInProgress.item_id,
            name: "web_search",
            input: { status: "in_progress" },
          });
          this.contentManager.markStarted(webSearchMeta.id);
        }
        break;

      case "response.web_search_call.searching":
        const webSearchSearching = ev as ResponseWebSearchCallSearchingEvent;
        const searchBlockResult = this.contentManager.getToolBlock(
          webSearchSearching.item_id
        );
        if (searchBlockResult && !searchBlockResult.metadata.completed) {
          // 検索中の状態をツール引数のデルタとして送信
          const searchingData = JSON.stringify({
            status: "searching",
            sequence: webSearchSearching.sequence_number,
          });
          searchBlockResult.metadata.argsBuffer = (searchBlockResult.metadata.argsBuffer || "") + searchingData;
          await this.sse.toolArgsDelta(searchBlockResult.metadata.index, searchingData);
        }
        break;

      case "response.web_search_call.completed":
        const webSearchCompleted = ev as ResponseWebSearchCallCompletedEvent;
        const completedBlockResult = this.contentManager.getToolBlock(
          webSearchCompleted.item_id
        );
        if (completedBlockResult && !completedBlockResult.metadata.completed) {
          // Web検索完了をツールブロックの終了として送信
          await this.sse.toolStop(completedBlockResult.metadata.index);
          this.contentManager.markCompleted(completedBlockResult.metadata.id);
        }
        break;

      default:
        console.warn("Unknown event type:", ev.type);
        break;
    }
  }

  private isItemIdString(
    ev: OpenAIResponseOutputItemAddedEvent | OpenAIResponseOutputItemDoneEvent
  ): ev is (
    | OpenAIResponseOutputItemAddedEvent
    | OpenAIResponseOutputItemDoneEvent
  ) & { item: { id: string } } {
    return typeof ev.item.id === "string";
  }

  /**
   * Get the response ID (if captured)
   */
  getResponseId(): string | undefined {
    return this.responseId;
  }

  getCallIdMapping(): Map<string, string> {
    return new Map(this.callIdMapping);
  }

  /**
   * Get current usage statistics
   */
  getUsage(): { input_tokens: number; output_tokens: number } {
    return { ...this.usage };
  }

  /**
   * Check if the stream is completed
   */
  isCompleted(): boolean {
    return this.streamCompleted;
  }
}
