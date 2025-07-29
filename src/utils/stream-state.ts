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
        const textBlock = this.contentManager.addTextBlock();
        this.currentTextBlockId = textBlock.id;
        await this.sse.textStart(textBlock.index);
        this.contentManager.markStarted(textBlock.id);
        return;

      case "response.output_text.delta":
        const currentBlock = this.currentTextBlockId
          ? this.contentManager.getBlock(this.currentTextBlockId)
          : this.contentManager.getCurrentTextBlock();
        if (currentBlock) {
          await this.sse.deltaText(currentBlock.index, ev.delta);
        }
        break;

      case "response.output_text.done":
        const doneBlock = this.currentTextBlockId
          ? this.contentManager.getBlock(this.currentTextBlockId)
          : this.contentManager.getCurrentTextBlock();
        if (doneBlock) {
          await this.sse.textStop(doneBlock.index);
          this.contentManager.markCompleted(doneBlock.id);
        }
        this.currentTextBlockId = undefined;
        break;

      case "response.output_item.added":
        if (ev.item.type === "function_call" && this.isItemIdString(ev)) {
          const toolBlock = this.contentManager.addToolBlock(
            ev.item.id,
            ev.item.name,
            ev.item.call_id
          );
          if (!toolBlock.started) {
            await this.sse.toolStart(toolBlock.index, {
              id: ev.item.id,
              name: ev.item.name,
            });
            this.contentManager.markStarted(toolBlock.id);
          }
        }
        break;

      case "response.function_call_arguments.delta":
        const toolBlock = this.contentManager.getToolBlock(ev.item_id);
        if (toolBlock && !toolBlock.completed) {
          toolBlock.argsBuffer += ev.delta;
          await this.sse.toolArgsDelta(toolBlock.index, ev.delta);
        }
        break;

      case "response.output_item.done":
        if (ev.item.type === "function_call" && this.isItemIdString(ev)) {
          const toolBlock = this.contentManager.getToolBlock(ev.item.id);
          if (toolBlock && !toolBlock.completed) {
            await this.sse.toolStop(toolBlock.index);
            this.contentManager.markCompleted(toolBlock.id);
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
        const newTextBlock = this.contentManager.addTextBlock();
        this.currentTextBlockId = newTextBlock.id;
        await this.sse.textStart(newTextBlock.index);
        this.contentManager.markStarted(newTextBlock.id);
        if (contentAddedEvent.part.type === "output_text") {
          await this.sse.deltaText(
            newTextBlock.index,
            contentAddedEvent.part.text
          );
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
        const textBlock = this.currentTextBlockId
          ? this.contentManager.getBlock(this.currentTextBlockId)
          : this.contentManager.getCurrentTextBlock();
        if (textBlock) {
          if (contentDoneEvent.part.type === "output_text") {
            await this.sse.deltaText(
              textBlock.index,
              contentDoneEvent.part.text
            );
          }
          await this.sse.textStop(textBlock.index);
          this.contentManager.markCompleted(textBlock.id);
        }
        this.currentTextBlockId = undefined;
        break;
      }

      case "response.function_call_arguments.done":
        const doneToolBlock = this.contentManager.getToolBlock(ev.item_id);
        if (doneToolBlock && !doneToolBlock.completed) {
          // Don't mark as completed here - wait for output_item.done
          console.log(
            `[StreamState] Tool args done for: ${doneToolBlock.name}`
          );
        }
        break;

      case "response.completed":
        // Stop any uncompleted blocks
        const uncompletedBlocks = this.contentManager.getUncompletedBlocks();
        for (const block of uncompletedBlocks) {
          if (block.type === "text") {
            await this.sse.textStop(block.index);
          } else if (block.type === "tool_use") {
            await this.sse.toolStop(block.index);
          }
          this.contentManager.markCompleted(block.id);
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
        const webSearchBlock = this.contentManager.addToolBlock(
          webSearchInProgress.item_id,
          "web_search"
        );
        if (!webSearchBlock.started) {
          await this.sse.toolStart(webSearchBlock.index, {
            id: webSearchInProgress.item_id,
            name: "web_search",
            input: { status: "in_progress" },
          });
          this.contentManager.markStarted(webSearchBlock.id);
        }
        break;

      case "response.web_search_call.searching":
        const webSearchSearching = ev as ResponseWebSearchCallSearchingEvent;
        const searchBlock = this.contentManager.getToolBlock(
          webSearchSearching.item_id
        );
        if (searchBlock && !searchBlock.completed) {
          // 検索中の状態をツール引数のデルタとして送信
          const searchingData = JSON.stringify({
            status: "searching",
            sequence: webSearchSearching.sequence_number,
          });
          searchBlock.argsBuffer += searchingData;
          await this.sse.toolArgsDelta(searchBlock.index, searchingData);
        }
        break;

      case "response.web_search_call.completed":
        const webSearchCompleted = ev as ResponseWebSearchCallCompletedEvent;
        const completedBlock = this.contentManager.getToolBlock(
          webSearchCompleted.item_id
        );
        if (completedBlock && !completedBlock.completed) {
          // Web検索完了をツールブロックの終了として送信
          await this.sse.toolStop(completedBlock.index);
          this.contentManager.markCompleted(completedBlock.id);
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
