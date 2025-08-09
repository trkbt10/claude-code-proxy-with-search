import { appendFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Non-blocking event logger that writes to JSONL files.
 */
export class EventLogger {
  private logPath: string;
  private enabled: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(logDir: string = "./logs", enabled: boolean = true) {
    this.enabled = enabled;
    const timestamp = new Date();
    const yyyyMMdd = `${timestamp.getFullYear()}-${String(
      timestamp.getMonth() + 1
    ).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`;
    this.logPath = join(logDir, `events-${yyyyMMdd}.jsonl`);
  }

  /**
   * Logs an event asynchronously without blocking.
   * Writes are queued to maintain order.
   */
  log(eventType: string, data: any): void {
    if (!this.enabled) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      type: eventType,
      data,
    };

    // Queue the write operation to maintain order
    this.writeQueue = this.writeQueue
      .then(async () => {
        try {
          await appendFile(this.logPath, JSON.stringify(logEntry) + "\n");
        } catch (error) {
          // Silently fail to avoid disrupting the main flow
          console.error(`[EventLogger] Failed to write log:`, error);
        }
      })
      .catch(() => {
        // Catch any errors to prevent unhandled promise rejections
      });
  }
}
