import type { SSEMessage, SSEStreamingApi } from "hono/streaming";

/**
 * Generic SSE Writer for sending Server-Sent Events
 */
export class SSEWriter {
  constructor(protected stream: SSEStreamingApi) {}

  protected async write(event: unknown, eventType?: string) {
    const msg: SSEMessage = {
      event: eventType,
      data: typeof event === "string" ? event : JSON.stringify(event),
    };
    await this.stream.writeSSE(msg);
  }

  get closed(): boolean {
    return this.stream.closed;
  }

  async sendEvent(eventType: string, data: unknown) {
    await this.write(data, eventType);
  }

  async sendData(data: unknown) {
    await this.write(data);
  }

  async ping() {
    const msg: SSEMessage = { data: "" };
    await this.stream.writeSSE(msg);
  }

  async error(type: string, message: string) {
    const msg: SSEMessage = {
      data: JSON.stringify({ type: "error", error: { type, message } }),
    };
    await this.stream.writeSSE(msg);
  }
}