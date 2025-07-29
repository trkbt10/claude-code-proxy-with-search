import { randomUUID } from "node:crypto";
import type { SSEWriter } from "./sse-writer";
import { EventLogger } from "./logger";
import type {
  ResponseStreamEvent as OpenAIResponseStreamEvent,
  ResponseOutputItemAddedEvent as OpenAIResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent as OpenAIResponseOutputItemDoneEvent,
  ResponseWebSearchCallInProgressEvent,
  ResponseWebSearchCallSearchingEvent,
  ResponseWebSearchCallCompletedEvent,
  ResponseCreatedEvent,
} from "openai/resources/responses/responses";

export class StreamState {
  textIndex = 0;
  toolIndex = 0;
  usage = { input_tokens: 0, output_tokens: 0 };
  toolBlockCounter = 0;
  toolCalls: Record<
    string,
    {
      index: number;
      name: string;
      argsBuffer: string;
      completed: boolean;
      call_id?: string;
    }
  > = {};
  messageId: string;
  messageStarted = false;
  responseId?: string;
  private pingTimer?: NodeJS.Timeout;
  private logger: EventLogger;
  private streamCompleted = false;

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
      await this.sse.textStart(this.textIndex);
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

  handleEvent(ev: OpenAIResponseStreamEvent) {
    // Ignore events after stream is completed
    if (this.streamCompleted) {
      console.warn("[StreamState] Ignoring event after stream completed:", ev.type);
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
        return;

      case "response.output_text.delta":
        this.sse.deltaText(this.textIndex, ev.delta);
        break;

      case "response.output_text.done":
        this.sse.textStop(this.textIndex);
        this.textIndex++;
        break;

      case "response.output_item.added":
        if (ev.item.type === "function_call" && this.isItemIdString(ev)) {
          if (!this.toolCalls[ev.item.id]) {
            this.toolBlockCounter++;
            const claudeIndex = this.textIndex + this.toolBlockCounter;
            this.toolCalls[ev.item.id] = {
              index: claudeIndex,
              name: ev.item.name,
              argsBuffer: "",
              completed: false,
              call_id: ev.item.call_id,
            };
            this.sse.toolStart(claudeIndex, {
              id: ev.item.id,
              name: ev.item.name,
            });
          }
        }
        break;

      case "response.function_call_arguments.delta":
        const call = this.toolCalls[ev.item_id];
        if (call && !call.completed) {
          call.argsBuffer += ev.delta;
          this.sse.toolArgsDelta(call.index, ev.delta);
        }
        break;

      case "response.output_item.done":
        if (ev.item.type === "function_call" && this.isItemIdString(ev)) {
          const call = this.toolCalls[ev.item.id];
          if (call && !call.completed) {
            // Mark as completed but don't delete yet - we need to keep track for tool results
            call.completed = true;
            const fullArgs = JSON.parse(ev.item.arguments);
            this.sse.toolStop(call.index);
            // Don't delete the tool call here - keep it for tracking
          }
        }
        break;

      case "response.content_part.added":
      case "response.content_part.done":
        console.warn(
          `[StreamState] Unhandled content part event: ${ev.type}, item_id=${ev.item_id}`
        );
        break;

      case "response.function_call_arguments.done":
        const doneCall = this.toolCalls[ev.item_id];
        if (doneCall && !doneCall.completed) {
          doneCall.completed = true;
          // Don't stop the tool here - wait for output_item.done
        }
        break;

      case "response.completed":
        // Only stop text if we're not waiting for tool results
        const hasActiveTool = Object.keys(this.toolCalls).length > 0;
        
        if (!hasActiveTool) {
          this.sse.textStop(this.textIndex);
        }

        Object.values(this.toolCalls).forEach((tc) => {
          if (!tc.completed) {
            this.sse.toolStop(tc.index);
          }
        });

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
        if (!this.toolCalls[webSearchInProgress.item_id]) {
          this.toolBlockCounter++;
          const claudeIndex = this.textIndex + this.toolBlockCounter;
          this.toolCalls[webSearchInProgress.item_id] = {
            index: claudeIndex,
            name: "web_search",
            argsBuffer: "",
            completed: false,
          };
          this.sse.toolStart(claudeIndex, { 
            id: webSearchInProgress.item_id, 
            name: "web_search",
            input: { status: "in_progress" }
          });
        }
        break;

      case "response.web_search_call.searching":
        const webSearchSearching = ev as ResponseWebSearchCallSearchingEvent;
        const searchCall = this.toolCalls[webSearchSearching.item_id];
        if (searchCall && !searchCall.completed) {
          // 検索中の状態をツール引数のデルタとして送信
          const searchingData = JSON.stringify({ 
            status: "searching",
            sequence: webSearchSearching.sequence_number 
          });
          searchCall.argsBuffer += searchingData;
          this.sse.toolArgsDelta(searchCall.index, searchingData);
        }
        break;

      case "response.web_search_call.completed":
        const webSearchCompleted = ev as ResponseWebSearchCallCompletedEvent;
        const completedCall = this.toolCalls[webSearchCompleted.item_id];
        if (completedCall && !completedCall.completed) {
          // Web検索完了をツールブロックの終了として送信
          completedCall.completed = true;
          this.sse.toolStop(completedCall.index);
          delete this.toolCalls[webSearchCompleted.item_id];
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
}
