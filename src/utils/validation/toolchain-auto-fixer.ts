import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logDebug, logWarn } from "../logging/migrate-logger";
import type { LogContext } from "../logging/enhanced-logger";

interface ToolChainIssue {
  type: "missing_tool_result" | "missing_tool_call" | "duplicate_id" | "mapping_mismatch";
  description: string;
  context: any;
  timestamp: Date;
  requestId?: string;
  conversationId?: string;
}

interface ToolChainFix {
  issue: ToolChainIssue;
  action: string;
  result: "success" | "failed" | "partial";
  details?: any;
  timestamp: Date;
}

/**
 * Automatically detects and fixes common toolchain issues
 */
export class ToolChainAutoFixer {
  private issues: ToolChainIssue[] = [];
  private fixes: ToolChainFix[] = [];
  private logDir: string;
  
  constructor(
    private context: LogContext = {},
    logDir: string = "./toolchain-fixes"
  ) {
    this.logDir = logDir;
    this.ensureLogDirectory();
  }

  private async ensureLogDirectory(): Promise<void> {
    if (!existsSync(this.logDir)) {
      try {
        await mkdir(this.logDir, { recursive: true });
      } catch (error) {
        logWarn("Failed to create toolchain fixes directory", { error }, this.context);
      }
    }
  }

  /**
   * Detect and attempt to fix a missing tool result
   */
  async fixMissingToolResult(
    toolCallId: string,
    toolName: string,
    pendingCalls: Map<string, any>
  ): Promise<ToolChainFix> {
    const issue: ToolChainIssue = {
      type: "missing_tool_result",
      description: `Tool call ${toolCallId} (${toolName}) has no matching result`,
      context: {
        toolCallId,
        toolName,
        pendingCallsCount: pendingCalls.size,
      },
      timestamp: new Date(),
      requestId: this.context.requestId as string,
      conversationId: this.context.conversationId as string,
    };
    
    this.issues.push(issue);
    
    // Attempt to fix by creating a synthetic error result
    const fix: ToolChainFix = {
      issue,
      action: "Created synthetic error result for missing tool response",
      result: "success",
      details: {
        syntheticResult: {
          tool_use_id: toolCallId,
          content: {
            error: "Tool execution timeout or missing response",
            tool_name: toolName,
            auto_generated: true,
          },
        },
      },
      timestamp: new Date(),
    };
    
    this.fixes.push(fix);
    
    logInfo(
      "Auto-fixed missing tool result",
      { toolCallId, toolName, fix: fix.action },
      this.context
    );
    
    // Write fix to markdown log
    await this.writeFixToMarkdown(fix);
    
    return fix;
  }

  /**
   * Fix duplicate tool call IDs
   */
  async fixDuplicateToolId(
    toolCallId: string,
    existingCall: any,
    newCall: any
  ): Promise<ToolChainFix> {
    const issue: ToolChainIssue = {
      type: "duplicate_id",
      description: `Duplicate tool call ID detected: ${toolCallId}`,
      context: {
        toolCallId,
        existingCall,
        newCall,
      },
      timestamp: new Date(),
      requestId: this.context.requestId as string,
      conversationId: this.context.conversationId as string,
    };
    
    this.issues.push(issue);
    
    // Generate a new unique ID for the second call
    const newId = `${toolCallId}_${Date.now()}`;
    
    const fix: ToolChainFix = {
      issue,
      action: `Generated new ID ${newId} for duplicate tool call`,
      result: "success",
      details: {
        originalId: toolCallId,
        newId,
      },
      timestamp: new Date(),
    };
    
    this.fixes.push(fix);
    
    logInfo(
      "Auto-fixed duplicate tool ID",
      { originalId: toolCallId, newId },
      this.context
    );
    
    await this.writeFixToMarkdown(fix);
    
    return fix;
  }

  /**
   * Fix mapping mismatches between call_id and tool_use_id
   */
  async fixMappingMismatch(
    callId: string,
    expectedToolId: string,
    actualToolId?: string
  ): Promise<ToolChainFix> {
    const issue: ToolChainIssue = {
      type: "mapping_mismatch",
      description: `Mapping mismatch for call_id ${callId}`,
      context: {
        callId,
        expectedToolId,
        actualToolId,
      },
      timestamp: new Date(),
      requestId: this.context.requestId as string,
      conversationId: this.context.conversationId as string,
    };
    
    this.issues.push(issue);
    
    const fix: ToolChainFix = {
      issue,
      action: `Corrected mapping: ${callId} -> ${expectedToolId}`,
      result: "success",
      details: {
        callId,
        correctedToolId: expectedToolId,
        previousToolId: actualToolId,
      },
      timestamp: new Date(),
    };
    
    this.fixes.push(fix);
    
    logInfo(
      "Auto-fixed mapping mismatch",
      { callId, correctedToolId: expectedToolId },
      this.context
    );
    
    await this.writeFixToMarkdown(fix);
    
    return fix;
  }

  /**
   * Write fix to markdown log file
   */
  private async writeFixToMarkdown(fix: ToolChainFix): Promise<void> {
    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const filename = `toolchain-fixes-${dateStr}.md`;
    const filepath = join(this.logDir, filename);
    
    // Create markdown entry
    const mdEntry = this.formatFixAsMarkdown(fix);
    
    try {
      // Check if file exists, if not create with header
      try {
        await readFile(filepath);
      } catch {
        // File doesn't exist, create with header
        const header = `# Toolchain Auto-Fix Log - ${dateStr}\n\n`;
        await appendFile(filepath, header);
      }
      
      // Append the fix entry
      await appendFile(filepath, mdEntry);
      
      logDebug(
        "Wrote fix to markdown log",
        { filepath, fixType: fix.issue.type },
        this.context
      );
    } catch (error) {
      logWarn(
        "Failed to write fix to markdown",
        { error, filepath },
        this.context
      );
    }
  }

  /**
   * Format a fix as markdown
   */
  private formatFixAsMarkdown(fix: ToolChainFix): string {
    const timestamp = fix.timestamp.toISOString();
    const requestId = fix.issue.requestId || "unknown";
    const conversationId = fix.issue.conversationId || "unknown";
    
    let md = `## Fix: ${fix.issue.type}\n\n`;
    md += `**Time:** ${timestamp}\n`;
    md += `**Request ID:** ${requestId}\n`;
    md += `**Conversation ID:** ${conversationId}\n`;
    md += `**Result:** ${fix.result}\n\n`;
    
    md += `### Issue\n`;
    md += `${fix.issue.description}\n\n`;
    
    md += `### Context\n`;
    md += "```json\n";
    md += JSON.stringify(fix.issue.context, null, 2);
    md += "\n```\n\n";
    
    md += `### Action Taken\n`;
    md += `${fix.action}\n\n`;
    
    if (fix.details) {
      md += `### Details\n`;
      md += "```json\n";
      md += JSON.stringify(fix.details, null, 2);
      md += "\n```\n\n";
    }
    
    md += `---\n\n`;
    
    return md;
  }

  /**
   * Generate a summary report
   */
  async generateSummaryReport(): Promise<string> {
    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const filename = `toolchain-summary-${dateStr}.md`;
    const filepath = join(this.logDir, filename);
    
    let report = `# Toolchain Fix Summary - ${dateStr}\n\n`;
    report += `## Statistics\n\n`;
    report += `- Total Issues Detected: ${this.issues.length}\n`;
    report += `- Total Fixes Applied: ${this.fixes.length}\n`;
    report += `- Success Rate: ${this.calculateSuccessRate()}%\n\n`;
    
    // Group by issue type
    report += `## Issues by Type\n\n`;
    const issuesByType = this.groupIssuesByType();
    for (const [type, count] of Object.entries(issuesByType)) {
      report += `- ${type}: ${count}\n`;
    }
    report += "\n";
    
    // Recent fixes
    report += `## Recent Fixes (Last 10)\n\n`;
    const recentFixes = this.fixes.slice(-10).reverse();
    for (const fix of recentFixes) {
      report += `- **${fix.issue.type}** at ${fix.timestamp.toLocaleTimeString()}: ${fix.action} (${fix.result})\n`;
    }
    report += "\n";
    
    // Common patterns
    report += `## Common Patterns\n\n`;
    const patterns = this.identifyCommonPatterns();
    for (const pattern of patterns) {
      report += `- ${pattern}\n`;
    }
    
    try {
      await appendFile(filepath, report);
      logInfo("Generated summary report", { filepath }, this.context);
    } catch (error) {
      logWarn("Failed to write summary report", { error, filepath }, this.context);
    }
    
    return report;
  }

  private calculateSuccessRate(): number {
    if (this.fixes.length === 0) return 0;
    const successful = this.fixes.filter(f => f.result === "success").length;
    return Math.round((successful / this.fixes.length) * 100);
  }

  private groupIssuesByType(): Record<string, number> {
    const groups: Record<string, number> = {};
    for (const issue of this.issues) {
      groups[issue.type] = (groups[issue.type] || 0) + 1;
    }
    return groups;
  }

  private identifyCommonPatterns(): string[] {
    const patterns: string[] = [];
    
    // Check for repeated tool names in issues
    const toolNames: Record<string, number> = {};
    for (const issue of this.issues) {
      if (issue.context.toolName) {
        toolNames[issue.context.toolName] = (toolNames[issue.context.toolName] || 0) + 1;
      }
    }
    
    for (const [name, count] of Object.entries(toolNames)) {
      if (count > 2) {
        patterns.push(`Tool "${name}" frequently has issues (${count} times)`);
      }
    }
    
    // Check for timing patterns
    const missingResults = this.issues.filter(i => i.type === "missing_tool_result");
    if (missingResults.length > 3) {
      patterns.push(`Missing tool results are common (${missingResults.length} occurrences) - may indicate timeout issues`);
    }
    
    return patterns;
  }

  /**
   * Reset for new conversation
   */
  reset(): void {
    this.issues = [];
    this.fixes = [];
  }
}

// Singleton instances per conversation
const fixers = new Map<string, ToolChainAutoFixer>();

/**
 * Get or create auto-fixer for a conversation
 */
export function getToolChainAutoFixer(
  conversationId: string,
  context?: LogContext
): ToolChainAutoFixer {
  if (!fixers.has(conversationId)) {
    fixers.set(conversationId, new ToolChainAutoFixer({ ...context, conversationId }));
  }
  return fixers.get(conversationId)!;
}

/**
 * Clean up auto-fixer for a conversation
 */
export function cleanupToolChainAutoFixer(conversationId: string): void {
  const fixer = fixers.get(conversationId);
  if (fixer) {
    // Generate final summary before cleanup
    fixer.generateSummaryReport();
    fixers.delete(conversationId);
  }
}