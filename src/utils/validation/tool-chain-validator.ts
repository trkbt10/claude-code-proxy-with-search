import { logUnexpected, logWarn, logDebug, captureState } from "../logging/migrate-logger";
import type { LogContext } from "../logging/enhanced-logger";
import { getToolChainAutoFixer } from "./toolchain-auto-fixer";

interface ToolCall {
  id: string;
  call_id?: string;
  name: string;
  arguments?: any;
}

interface ToolResult {
  tool_use_id: string;
  content: any;
}

/**
 * Validates tool chain execution for consistency and correctness
 */
export class ToolChainValidator {
  private pendingToolCalls: Map<string, ToolCall> = new Map();
  private completedToolCalls: Set<string> = new Set();
  private toolCallHistory: Array<{ timestamp: Date; event: string; data: any }> = [];
  
  constructor(private context: LogContext = {}) {}

  /**
   * Record a tool call being made
   */
  recordToolCall(toolCall: ToolCall): void {
    const timestamp = new Date();
    this.toolCallHistory.push({ timestamp, event: "tool_call", data: toolCall });
    
    logDebug("Tool call recorded", toolCall, this.context);
    
    // Check for duplicate tool call IDs
    if (this.pendingToolCalls.has(toolCall.id)) {
      logUnexpected(
        "Each tool call should have a unique ID",
        `Duplicate tool call ID: ${toolCall.id}`,
        {
          existingCall: this.pendingToolCalls.get(toolCall.id),
          newCall: toolCall,
          history: this.toolCallHistory.slice(-5),
        },
        this.context
      );
      
      // Attempt auto-fix
      const fixer = getToolChainAutoFixer(this.context.conversationId || "unknown", this.context);
      fixer.fixDuplicateToolId(
        toolCall.id,
        this.pendingToolCalls.get(toolCall.id),
        toolCall
      );
    }
    
    this.pendingToolCalls.set(toolCall.id, toolCall);
    
    // Check for missing call_id
    if (!toolCall.call_id) {
      logWarn(
        "Tool call missing call_id",
        { toolCall, pendingCount: this.pendingToolCalls.size },
        this.context
      );
    }
  }

  /**
   * Record a tool result being received
   */
  recordToolResult(toolResult: ToolResult): void {
    const timestamp = new Date();
    this.toolCallHistory.push({ timestamp, event: "tool_result", data: toolResult });
    
    logDebug("Tool result recorded", toolResult, this.context);
    
    // Find matching tool call
    let matchingCall: ToolCall | undefined;
    for (const [id, call] of this.pendingToolCalls.entries()) {
      if (id === toolResult.tool_use_id || call.call_id === toolResult.tool_use_id) {
        matchingCall = call;
        break;
      }
    }
    
    if (!matchingCall) {
      // This is the main issue - tool result without matching call
      logUnexpected(
        "Every tool result should have a matching tool call",
        `Tool result without matching call: ${toolResult.tool_use_id}`,
        {
          toolResult,
          pendingCalls: Array.from(this.pendingToolCalls.entries()),
          completedCalls: Array.from(this.completedToolCalls),
          recentHistory: this.toolCallHistory.slice(-10),
        },
        this.context
      );
      
      // Capture full state for debugging
      captureState("Tool chain mismatch", {
        pendingToolCalls: Object.fromEntries(this.pendingToolCalls),
        completedToolCalls: Array.from(this.completedToolCalls),
        fullHistory: this.toolCallHistory,
      }, this.context);
      
      // Attempt auto-fix by creating synthetic tool call
      const fixer = getToolChainAutoFixer(this.context.conversationId || "unknown", this.context);
      // For now, we can't auto-fix missing tool calls easily
      // but we log it for analysis
    } else {
      // Mark as completed
      this.pendingToolCalls.delete(matchingCall.id);
      this.completedToolCalls.add(matchingCall.id);
      
      // Validate result content
      if (!toolResult.content && toolResult.content !== 0 && toolResult.content !== false) {
        logWarn(
          "Tool result has empty content",
          { toolResult, matchingCall },
          this.context
        );
      }
    }
  }

  /**
   * Check for orphaned tool calls at the end of a conversation turn
   */
  validateEndOfTurn(): void {
    if (this.pendingToolCalls.size > 0) {
      logUnexpected(
        "All tool calls should have matching results by end of turn",
        `${this.pendingToolCalls.size} tool calls without results`,
        {
          pendingCalls: Array.from(this.pendingToolCalls.entries()),
          completedCount: this.completedToolCalls.size,
          recentHistory: this.toolCallHistory.slice(-10),
        },
        this.context
      );
      
      // Attempt auto-fix for each orphaned tool call
      const fixer = getToolChainAutoFixer(this.context.conversationId || "unknown", this.context);
      for (const [id, call] of this.pendingToolCalls.entries()) {
        fixer.fixMissingToolResult(id, call.name, this.pendingToolCalls);
      }
    }
  }

  /**
   * Validate tool call to result mapping
   */
  validateMapping(callIdMapping: Map<string, string>): void {
    logDebug(
      "Validating tool call mapping",
      {
        mappingSize: callIdMapping.size,
        pendingCalls: this.pendingToolCalls.size,
        completedCalls: this.completedToolCalls.size,
      },
      this.context
    );
    
    // Check if all pending calls have mappings
    for (const [id, call] of this.pendingToolCalls.entries()) {
      if (call.call_id && !callIdMapping.has(call.call_id)) {
        logWarn(
          "Tool call missing from mapping",
          { toolCallId: id, callId: call.call_id },
          this.context
        );
      }
    }
  }

  /**
   * Reset validator for new conversation
   */
  reset(): void {
    this.pendingToolCalls.clear();
    this.completedToolCalls.clear();
    this.toolCallHistory = [];
  }

  /**
   * Get current state for debugging
   */
  getState(): any {
    return {
      pendingToolCalls: Array.from(this.pendingToolCalls.entries()),
      completedToolCalls: Array.from(this.completedToolCalls),
      historyLength: this.toolCallHistory.length,
      recentHistory: this.toolCallHistory.slice(-5),
    };
  }
}

// Singleton instance per conversation
const validators = new Map<string, ToolChainValidator>();

/**
 * Get or create validator for a conversation
 */
export function getToolChainValidator(conversationId: string, context?: LogContext): ToolChainValidator {
  if (!validators.has(conversationId)) {
    validators.set(conversationId, new ToolChainValidator({ ...context, conversationId }));
  }
  return validators.get(conversationId)!;
}

/**
 * Clean up validator for a conversation
 */
export function cleanupToolChainValidator(conversationId: string): void {
  validators.delete(conversationId);
}