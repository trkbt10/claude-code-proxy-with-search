import { StreamState } from "./stream-state";
import type { SSEWriter } from "./sse-writer";

/**
 * Manages StreamState instances lifecycle
 * Creates instances on request and releases them when done
 */
export class StreamStateManager {
  private activeStreams: Map<string, StreamState> = new Map();

  /**
   * Create a new StreamState instance for a request
   */
  createStream(requestId: string, sse: SSEWriter, logEnabled?: boolean): StreamState {
    if (this.activeStreams.has(requestId)) {
      throw new Error(`Stream already exists for request: ${requestId}`);
    }

    const stream = new StreamState(sse, logEnabled);
    this.activeStreams.set(requestId, stream);
    
    console.log(`[StreamStateManager] Created stream for request: ${requestId}`);
    console.log(`[StreamStateManager] Active streams: ${this.activeStreams.size}`);
    
    return stream;
  }

  /**
   * Release a StreamState instance when done
   */
  releaseStream(requestId: string): void {
    const stream = this.activeStreams.get(requestId);
    if (stream) {
      stream.cleanup();
      this.activeStreams.delete(requestId);
      
      console.log(`[StreamStateManager] Released stream for request: ${requestId}`);
      console.log(`[StreamStateManager] Active streams: ${this.activeStreams.size}`);
    }
  }

  /**
   * Get an active stream by request ID
   */
  getStream(requestId: string): StreamState | undefined {
    return this.activeStreams.get(requestId);
  }

  /**
   * Get the number of active streams
   */
  getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  /**
   * Clean up all active streams (for graceful shutdown)
   */
  cleanupAll(): void {
    console.log(`[StreamStateManager] Cleaning up ${this.activeStreams.size} active streams`);
    
    for (const [requestId, stream] of this.activeStreams) {
      stream.cleanup();
      console.log(`[StreamStateManager] Cleaned up stream: ${requestId}`);
    }
    
    this.activeStreams.clear();
  }
}

// Export a singleton instance
export const streamStateManager = new StreamStateManager();