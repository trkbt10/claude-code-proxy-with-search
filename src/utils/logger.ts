import { appendFileSync } from "node:fs";
import { join } from "node:path";

export class EventLogger {
  private logPath: string;
  private enabled: boolean;

  constructor(logDir: string = "./logs", enabled: boolean = true) {
    this.enabled = enabled;
    const timestamp = new Date();
    const yyyyMMdd = `${timestamp.getFullYear()}-${String(
      timestamp.getMonth() + 1
    ).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`;
    this.logPath = join(logDir, `events-${yyyyMMdd}.jsonl`);
  }

  log(eventType: string, data: any) {
    if (!this.enabled) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      type: eventType,
      data,
    };

    try {
      appendFileSync(this.logPath, JSON.stringify(logEntry) + "\n");
    } catch (error) {
      // Silently fail to avoid disrupting the main flow
    }
  }
}
