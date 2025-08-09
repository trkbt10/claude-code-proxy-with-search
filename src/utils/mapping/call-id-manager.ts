import { logDebug, logWarn, logError, logUnexpected } from "../logging/migrate-logger";

export interface CallIdMappingEntry {
  openaiCallId: string;
  claudeToolUseId: string;
  toolName?: string;
  createdAt: Date;
  usedAt?: Date;
  status: "pending" | "used" | "orphaned";
  context?: any;
}

export interface CallIdMappingStats {
  totalMappings: number;
  pendingMappings: number;
  usedMappings: number;
  orphanedMappings: number;
  prefixConversions: number;
  errors: string[];
}

/**
 * Centralized manager for call ID mappings between OpenAI and Claude
 * Provides debugging, validation, error tracking, and ID prefix fixing
 */
export class CallIdManager {
  private static readonly VALID_PREFIXES = ["fc_", "call_"]; // Both OpenAI formats are valid
  private static readonly INVALID_PREFIXES = ["ws_", "tool_", "tc_"];
  private mappings: Map<string, CallIdMappingEntry> = new Map();
  private reverseMapping: Map<string, string> = new Map(); // claudeId -> openaiId
  private conversationMappings: Map<string, Set<string>> = new Map(); // conversationId -> Set<openaiCallIds>
  private prefixConversionLog: Array<{ original: string; fixed: string; timestamp: Date }> = [];
  private readonly maxLogSize = 100;

  constructor(private conversationId?: string) {}

  /**
   * Fix an ID to have the correct prefix (integrated from IdPrefixValidator)
   */
  static fixIdPrefix(id: string, context?: string): string {
    // If already valid, return as-is
    for (const validPrefix of CallIdManager.VALID_PREFIXES) {
      if (id.startsWith(validPrefix)) {
        return id;
      }
    }
    
    // Check for known invalid prefixes
    for (const invalidPrefix of CallIdManager.INVALID_PREFIXES) {
      if (id.startsWith(invalidPrefix)) {
        const fixedId = "fc_" + id.substring(invalidPrefix.length);
        logDebug(
          `Fixed ID prefix`,
          { 
            original: id, 
            fixed: fixedId, 
            context: context || "unknown"
          }
        );
        return fixedId;
      }
    }
    
    // If no known prefix, add fc_ prefix
    if (!id.includes("_")) {
      const fixedId = "fc_" + id;
      logWarn(
        `ID has no prefix, adding fc_`,
        { original: id, fixed: fixedId, context: context || "unknown" }
      );
      return fixedId;
    }
    
    // Unknown prefix pattern, replace everything before first underscore
    const underscoreIndex = id.indexOf("_");
    const fixedId = "fc_" + id.substring(underscoreIndex + 1);
    logWarn(
      `Unknown ID prefix pattern, replacing with fc_`,
      { original: id, fixed: fixedId, context: context || "unknown" }
    );
    return fixedId;
  }

  /**
   * Check if an ID has a valid prefix for OpenAI API
   */
  static isValidPrefix(id: string): boolean {
    for (const validPrefix of CallIdManager.VALID_PREFIXES) {
      if (id.startsWith(validPrefix)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Extract the actual ID without prefix
   */
  static extractIdWithoutPrefix(id: string): string {
    const underscoreIndex = id.indexOf("_");
    if (underscoreIndex === -1) {
      return id;
    }
    return id.substring(underscoreIndex + 1);
  }

  /**
   * Check if two IDs are the same ignoring prefix
   */
  static isSameIdIgnoringPrefix(id1: string, id2: string): boolean {
    return CallIdManager.extractIdWithoutPrefix(id1) === CallIdManager.extractIdWithoutPrefix(id2);
  }

  /**
   * Register a new call ID mapping
   */
  registerMapping(
    openaiCallId: string,
    claudeToolUseId: string,
    toolName?: string,
    context?: any
  ): void {
    // Don't fix prefixes - keep original IDs as they are
    // OpenAI uses call_xxx, Claude uses toolu_xxx
    const fixedOpenaiId = openaiCallId;
    const fixedClaudeId = claudeToolUseId;

    // Log prefix conversions
    if (fixedOpenaiId !== openaiCallId || fixedClaudeId !== claudeToolUseId) {
      this.logPrefixConversion(openaiCallId, fixedOpenaiId);
      this.logPrefixConversion(claudeToolUseId, fixedClaudeId);
    }

    // Check for duplicates
    if (this.mappings.has(fixedOpenaiId)) {
      const existing = this.mappings.get(fixedOpenaiId)!;
      logWarn(
        "Duplicate call ID mapping detected",
        {
          openaiCallId: fixedOpenaiId,
          existingClaudeId: existing.claudeToolUseId,
          newClaudeId: fixedClaudeId,
        },
        { conversationId: this.conversationId }
      );
    }

    // Store the mapping
    const entry: CallIdMappingEntry = {
      openaiCallId: fixedOpenaiId,
      claudeToolUseId: fixedClaudeId,
      toolName,
      createdAt: new Date(),
      status: "pending",
      context,
    };

    this.mappings.set(fixedOpenaiId, entry);
    this.reverseMapping.set(fixedClaudeId, fixedOpenaiId);

    // Track by conversation
    if (this.conversationId) {
      if (!this.conversationMappings.has(this.conversationId)) {
        this.conversationMappings.set(this.conversationId, new Set());
      }
      this.conversationMappings.get(this.conversationId)!.add(fixedOpenaiId);
    }

    logDebug(
      "Registered call ID mapping",
      {
        openaiCallId: fixedOpenaiId,
        claudeToolUseId: fixedClaudeId,
        toolName,
      },
      { conversationId: this.conversationId }
    );
  }

  /**
   * Get OpenAI call ID from Claude tool use ID
   */
  getOpenAICallId(claudeToolUseId: string): string | undefined {
    const fixedId = CallIdManager.fixIdPrefix(claudeToolUseId, "lookup_claude_id");
    
    // Direct lookup
    const directResult = this.reverseMapping.get(fixedId);
    if (directResult) {
      this.markAsUsed(directResult);
      return directResult;
    }

    // Try to find by ignoring prefix
    for (const [claudeId, openaiId] of this.reverseMapping.entries()) {
      if (CallIdManager.isSameIdIgnoringPrefix(claudeId, claudeToolUseId)) {
        logDebug(
          "Found mapping by ignoring prefix",
          { original: claudeToolUseId, matched: claudeId, openaiId },
          { conversationId: this.conversationId }
        );
        this.markAsUsed(openaiId);
        return openaiId;
      }
    }

    logWarn(
      "No OpenAI call ID found for Claude tool use ID",
      { claudeToolUseId: fixedId },
      { conversationId: this.conversationId }
    );
    return undefined;
  }

  /**
   * Get Claude tool use ID from OpenAI call ID
   */
  getClaudeToolUseId(openaiCallId: string): string | undefined {
    const fixedId = CallIdManager.fixIdPrefix(openaiCallId, "lookup_openai_id");
    const entry = this.mappings.get(fixedId);
    
    if (entry) {
      this.markAsUsed(fixedId);
      return entry.claudeToolUseId;
    }

    // Try to find by ignoring prefix
    for (const [oId, mapping] of this.mappings.entries()) {
      if (CallIdManager.isSameIdIgnoringPrefix(oId, openaiCallId)) {
        logDebug(
          "Found mapping by ignoring prefix",
          { original: openaiCallId, matched: oId, claudeId: mapping.claudeToolUseId },
          { conversationId: this.conversationId }
        );
        this.markAsUsed(oId);
        return mapping.claudeToolUseId;
      }
    }

    logWarn(
      "No Claude tool use ID found for OpenAI call ID",
      { openaiCallId: fixedId },
      { conversationId: this.conversationId }
    );
    return undefined;
  }

  /**
   * Mark a mapping as used
   */
  private markAsUsed(openaiCallId: string): void {
    const entry = this.mappings.get(openaiCallId);
    if (entry) {
      entry.status = "used";
      entry.usedAt = new Date();
    }
  }

  /**
   * Mark unmapped IDs as orphaned
   */
  markOrphaned(ids: string[]): void {
    for (const id of ids) {
      const fixedId = CallIdManager.fixIdPrefix(id, "orphaned_id");
      const entry = this.mappings.get(fixedId);
      if (entry && entry.status === "pending") {
        entry.status = "orphaned";
        logWarn(
          "Marked mapping as orphaned",
          { openaiCallId: fixedId, claudeToolUseId: entry.claudeToolUseId },
          { conversationId: this.conversationId }
        );
      }
    }
  }

  /**
   * Get all mappings as a Map for backward compatibility
   */
  getMappingAsMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [openaiId, entry] of this.mappings.entries()) {
      map.set(openaiId, entry.claudeToolUseId);
    }
    return map;
  }

  /**
   * Import mappings from a Map (for backward compatibility)
   */
  importFromMap(map: Map<string, string>, context?: any): void {
    for (const [openaiId, claudeId] of map.entries()) {
      this.registerMapping(openaiId, claudeId, undefined, context);
    }
  }

  /**
   * Get statistics about current mappings
   */
  getStats(): CallIdMappingStats {
    let pending = 0;
    let used = 0;
    let orphaned = 0;
    const errors: string[] = [];

    for (const entry of this.mappings.values()) {
      switch (entry.status) {
        case "pending":
          pending++;
          break;
        case "used":
          used++;
          break;
        case "orphaned":
          orphaned++;
          errors.push(`Orphaned: ${entry.openaiCallId} -> ${entry.claudeToolUseId}`);
          break;
      }
    }

    return {
      totalMappings: this.mappings.size,
      pendingMappings: pending,
      usedMappings: used,
      orphanedMappings: orphaned,
      prefixConversions: this.prefixConversionLog.length,
      errors,
    };
  }

  /**
   * Log prefix conversion for debugging
   */
  private logPrefixConversion(original: string, fixed: string): void {
    if (original !== fixed) {
      this.prefixConversionLog.push({
        original,
        fixed,
        timestamp: new Date(),
      });

      // Keep log size manageable
      if (this.prefixConversionLog.length > this.maxLogSize) {
        this.prefixConversionLog.shift();
      }

      // Log using the correct method signature
      logDebug(
        `ID prefix conversion: ${original} -> ${fixed}`,
        {
          original,
          fixed,
          conversationId: this.conversationId,
        }
      );
    }
  }

  /**
   * Validate all mappings and report issues
   */
  validateMappings(): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check for orphaned mappings
    const orphaned = Array.from(this.mappings.values()).filter(
      (e) => e.status === "orphaned"
    );
    if (orphaned.length > 0) {
      issues.push(`Found ${orphaned.length} orphaned mappings`);
    }

    // Check for duplicate Claude IDs
    const claudeIds = new Set<string>();
    for (const entry of this.mappings.values()) {
      if (claudeIds.has(entry.claudeToolUseId)) {
        issues.push(`Duplicate Claude ID: ${entry.claudeToolUseId}`);
      }
      claudeIds.add(entry.claudeToolUseId);
    }

    // Check for invalid prefixes
    for (const entry of this.mappings.values()) {
      if (!CallIdManager.isValidPrefix(entry.openaiCallId)) {
        issues.push(`Invalid OpenAI ID prefix: ${entry.openaiCallId}`);
      }
    }

    if (issues.length > 0) {
      logUnexpected(
        "Call ID mapping validation failed",
        `Found ${issues.length} issues`,
        { issues, stats: this.getStats() },
        { conversationId: this.conversationId }
      );
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * Generate debug report
   */
  generateDebugReport(): string {
    const stats = this.getStats();
    const validation = this.validateMappings();
    
    const report = [
      `=== Call ID Mapping Debug Report ===`,
      `Conversation ID: ${this.conversationId || "unknown"}`,
      `Generated at: ${new Date().toISOString()}`,
      ``,
      `=== Statistics ===`,
      `Total Mappings: ${stats.totalMappings}`,
      `Pending: ${stats.pendingMappings}`,
      `Used: ${stats.usedMappings}`,
      `Orphaned: ${stats.orphanedMappings}`,
      `Prefix Conversions: ${stats.prefixConversions}`,
      ``,
      `=== Validation ===`,
      `Valid: ${validation.valid}`,
      validation.issues.length > 0 ? `Issues:\n${validation.issues.map(i => `  - ${i}`).join("\n")}` : "",
      ``,
      `=== Current Mappings ===`,
    ];

    for (const [openaiId, entry] of this.mappings.entries()) {
      report.push(
        `${entry.status.padEnd(8)} | ${openaiId} -> ${entry.claudeToolUseId}${
          entry.toolName ? ` (${entry.toolName})` : ""
        }`
      );
    }

    if (this.prefixConversionLog.length > 0) {
      report.push(``, `=== Recent Prefix Conversions ===`);
      for (const conv of this.prefixConversionLog.slice(-10)) {
        report.push(`${conv.timestamp.toISOString()} | ${conv.original} -> ${conv.fixed}`);
      }
    }

    return report.join("\n");
  }

  /**
   * Clear all mappings
   */
  clear(): void {
    this.mappings.clear();
    this.reverseMapping.clear();
    this.prefixConversionLog = [];
    if (this.conversationId) {
      this.conversationMappings.delete(this.conversationId);
    }
  }
}

/**
 * Global registry for all CallIdManagers
 */
class CallIdManagerRegistry {
  private managers: Map<string, CallIdManager> = new Map();

  getManager(conversationId: string): CallIdManager {
    if (!this.managers.has(conversationId)) {
      this.managers.set(conversationId, new CallIdManager(conversationId));
    }
    return this.managers.get(conversationId)!;
  }

  clearManager(conversationId: string): void {
    const manager = this.managers.get(conversationId);
    if (manager) {
      manager.clear();
      this.managers.delete(conversationId);
    }
  }

  generateGlobalReport(): string {
    const reports: string[] = [];
    for (const [convId, manager] of this.managers.entries()) {
      reports.push(manager.generateDebugReport());
      reports.push("");
    }
    return reports.join("\n");
  }
}

export const callIdRegistry = new CallIdManagerRegistry();