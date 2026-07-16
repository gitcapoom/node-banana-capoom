/**
 * Centralized logging utility for Node Banana Capoom
 *
 * Features:
 * - Session-based logging (one log file per workflow execution)
 * - Automatic rotation (keeps last 10 sessions)
 * - Privacy-aware (truncates prompts, logs image metadata not full data)
 * - Structured JSON format
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogCategory =
  | 'workflow.start'
  | 'workflow.end'
  | 'workflow.error'
  | 'workflow.validation'
  | 'node.execution'
  | 'node.error'
  | 'api.gemini'
  | 'api.openai'
  | 'api.llm'
  | 'api.error'
  | 'file.save'
  | 'file.load'
  | 'file.error'
  | 'connection.validation'
  | 'state.change'
  | 'system';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  context?: Record<string, any>;
  error?: {
    message: string;
    stack?: string;
    name?: string;
  };
}

export interface LogSession {
  sessionId: string;
  startTime: string;
  endTime?: string;
  entries: LogEntry[];
}

// Type for server-only operations
type LoggerServer = {
  saveSession: (session: LogSession) => Promise<void>;
  rotateLogFiles: () => Promise<void>;
};

class Logger {
  private currentSession: LogSession | null = null;
  private isClient: boolean;

  constructor() {
    this.isClient = typeof window !== 'undefined';
  }

  /**
   * Initialize a new logging session for a workflow execution
   * Note: On client side, this just tracks in memory. File writing happens server-side in API routes.
   */
  async startSession(): Promise<string> {
    const sessionId = this.generateSessionId();
    const startTime = new Date().toISOString();

    this.currentSession = {
      sessionId,
      startTime,
      entries: [],
    };

    this.log('info', 'system', `Session started: ${sessionId}`);

    return sessionId;
  }

  /**
   * End the current session
   * Note: On client side, this just clears memory. File writing happens server-side in API routes.
   */
  async endSession(): Promise<void> {
    if (!this.currentSession) {
      return;
    }

    this.currentSession.endTime = new Date().toISOString();
    this.log('info', 'system', `Session ended: ${this.currentSession.sessionId}`);

    this.currentSession = null;
  }

  /**
   * Get the current session (useful for server-side code to save it)
   */
  getCurrentSession(): LogSession | null {
    return this.currentSession;
  }

  /**
   * Log a message
   */
  log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    context?: Record<string, any>,
    error?: Error
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
    };

    if (context) {
      entry.context = this.sanitizeContext(context);
    }

    if (error) {
      entry.error = {
        message: error.message,
        stack: error.stack,
        name: error.name,
      };
    }

    // Add to current session if exists
    if (this.currentSession) {
      this.currentSession.entries.push(entry);
    }

    // Also log to console for development — the SANITIZED context, so a
    // giant raw value can't hang the console / dev-terminal relay.
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[consoleMethod](`[${category}] ${message}`, entry.context || '', error || '');
  }

  /**
   * Convenience methods
   */
  info(category: LogCategory, message: string, context?: Record<string, any>): void {
    this.log('info', category, message, context);
  }

  warn(category: LogCategory, message: string, context?: Record<string, any>): void {
    this.log('warn', category, message, context);
  }

  error(category: LogCategory, message: string, context?: Record<string, any>, error?: Error): void {
    this.log('error', category, message, context, error);
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.currentSession?.sessionId || null;
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const random = Math.random().toString(36).substring(2, 8);
    return `exec-${timestamp}-${random}`;
  }

  /**
   * Sanitize context to protect privacy and BOUND log size. Every value is
   * capped: any data: URL (any key) becomes metadata, other strings truncate,
   * arrays and depth are limited. Log entries accumulate into the session and
   * are JSON.stringify'd on endSession — one unbounded value (e.g. a video
   * data URL in an executor's context) used to blow past V8's string limit
   * ("Invalid string length") and crash the RUN that was ending its session.
   */
  private sanitizeContext(context: Record<string, any>): Record<string, any> {
    const MAX_STRING = 2000;
    const MAX_ARRAY = 50;
    const MAX_DEPTH = 4;

    const bound = (value: any, depth: number): any => {
      if (typeof value === 'string') {
        if (value.startsWith('data:')) {
          return value.startsWith('data:image')
            ? this.extractImageMetadata(value)
            : { isDataURI: true, mime: value.slice(5, value.indexOf(';')), sizeKB: Math.round((value.length * 0.75) / 1024) };
        }
        return value.length > MAX_STRING ? value.substring(0, MAX_STRING) + `…[+${value.length - MAX_STRING} chars]` : value;
      }
      if (Array.isArray(value)) {
        if (depth >= MAX_DEPTH) return `[array(${value.length})]`;
        const capped = value.slice(0, MAX_ARRAY).map((v) => bound(v, depth + 1));
        if (value.length > MAX_ARRAY) capped.push(`…[+${value.length - MAX_ARRAY} more]`);
        return capped;
      }
      if (typeof value === 'object' && value !== null) {
        if (depth >= MAX_DEPTH) return '[object]';
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
          // Prompts stay extra short — privacy plus signal density.
          out[k] = k === 'prompt' && typeof v === 'string' && v.length > 200
            ? v.substring(0, 200) + '...[truncated]'
            : bound(v, depth + 1);
        }
        return out;
      }
      return value;
    };

    return bound(context, 0) as Record<string, any>;
  }

  /**
   * Extract metadata from image data URI
   */
  private extractImageMetadata(dataUri: string): object {
    const match = dataUri.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
      return { error: 'Invalid image data URI' };
    }

    const [, format, base64Data] = match;
    const sizeInBytes = base64Data.length * 0.75; // Approximate size from base64
    const sizeInKB = Math.round(sizeInBytes / 1024);

    return {
      format,
      sizeKB: sizeInKB,
      isDataURI: true,
    };
  }

}

// Export singleton instance
export const logger = new Logger();
