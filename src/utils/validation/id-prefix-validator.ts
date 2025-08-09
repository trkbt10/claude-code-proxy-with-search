import { logWarn, logDebug } from "../logging/migrate-logger";

/**
 * Validates and fixes ID prefixes for OpenAI API compatibility
 */
export class IdPrefixValidator {
  private static readonly VALID_PREFIX = "fc_";
  private static readonly INVALID_PREFIXES = ["ws_", "tool_", "tc_"];
  
  /**
   * Check if an ID has a valid prefix for OpenAI API
   */
  static isValidPrefix(id: string): boolean {
    return id.startsWith(this.VALID_PREFIX);
  }
  
  /**
   * Fix an ID to have the correct prefix
   */
  static fixIdPrefix(id: string, context?: string): string {
    // If already valid, return as-is
    if (this.isValidPrefix(id)) {
      return id;
    }
    
    // Check for known invalid prefixes
    for (const invalidPrefix of this.INVALID_PREFIXES) {
      if (id.startsWith(invalidPrefix)) {
        const fixedId = this.VALID_PREFIX + id.substring(invalidPrefix.length);
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
      const fixedId = this.VALID_PREFIX + id;
      logWarn(
        `ID has no prefix, adding fc_`,
        { original: id, fixed: fixedId, context: context || "unknown" }
      );
      return fixedId;
    }
    
    // Unknown prefix pattern, replace everything before first underscore
    const underscoreIndex = id.indexOf("_");
    const fixedId = this.VALID_PREFIX + id.substring(underscoreIndex + 1);
    logWarn(
      `Unknown ID prefix pattern, replacing with fc_`,
      { original: id, fixed: fixedId, context: context || "unknown" }
    );
    return fixedId;
  }
  
  /**
   * Validate and fix a batch of IDs
   */
  static fixIdBatch(ids: string[], context?: string): Map<string, string> {
    const mapping = new Map<string, string>();
    
    for (const id of ids) {
      const fixedId = this.fixIdPrefix(id, context);
      if (fixedId !== id) {
        mapping.set(id, fixedId);
      }
    }
    
    if (mapping.size > 0) {
      logDebug(
        `Fixed ${mapping.size} IDs in batch`,
        { 
          count: mapping.size,
          mappings: Array.from(mapping.entries()),
          context: context || "unknown"
        }
      );
    }
    
    return mapping;
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
    return this.extractIdWithoutPrefix(id1) === this.extractIdWithoutPrefix(id2);
  }
}