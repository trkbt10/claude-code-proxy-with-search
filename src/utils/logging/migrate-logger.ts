import { getLogger, type LogContext } from "./enhanced-logger";

const logger = getLogger();

/**
 * Helper functions to migrate from console.log/error to enhanced logger
 */

export function logInfo(message: string, data?: any, context?: LogContext): void {
  logger.info(message, data, context);
  if (process.env.DEBUG === "true") {
    console.log(`[INFO] ${message}`, data);
  }
}

export function logError(message: string, error?: any, context?: LogContext): void {
  logger.error(message, error, context);
  console.error(`[ERROR] ${message}`, error);
}

export function logWarn(message: string, data?: any, context?: LogContext): void {
  logger.warn(message, data, context);
  if (process.env.DEBUG === "true") {
    console.warn(`[WARN] ${message}`, data);
  }
}

export function logDebug(message: string, data?: any, context?: LogContext): void {
  logger.debug(message, data, context);
  if (process.env.DEBUG === "true") {
    console.log(`[DEBUG] ${message}`, data);
  }
}

export function logUnexpected(
  expected: string,
  actual: string,
  contextData: Record<string, any>,
  context?: LogContext
): void {
  logger.unexpected(
    {
      expected,
      actual,
      context: contextData,
    },
    context
  );
}

export function logRequestResponse(
  request: any,
  response: any,
  duration: number,
  context?: LogContext
): void {
  logger.logRequestResponse(request, response, duration, context);
}

export function logConversionIssue(
  from: string,
  to: string,
  input: any,
  error: string,
  context?: LogContext
): void {
  logger.logConversionIssue(from, to, input, error, context);
}

export function captureState(label: string, state: Record<string, any>, context?: LogContext): void {
  logger.captureState(label, state, context);
}

export function logPerformance(
  operation: string,
  duration: number,
  metadata?: any,
  context?: LogContext
): void {
  logger.logPerformance(operation, duration, metadata, context);
}

// Export the logger instance for direct use
export { logger };