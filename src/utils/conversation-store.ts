interface ConversationContext {
  messages: any[];
  lastToolCalls?: Record<string, any>;
  lastResponseId?: string;
  callIdMapping?: Map<string, string>; // Maps OpenAI call_id to Claude tool_use_id
  createdAt: Date;
  lastAccessedAt: Date;
}

export class ConversationStore {
  private conversations = new Map<string, ConversationContext>();
  private cleanupInterval: NodeJS.Timeout;
  private readonly maxAge = 30 * 60 * 1000; // 30 minutes

  constructor() {
    // Clean up old conversations every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
  }

  getOrCreate(conversationId: string): ConversationContext {
    const existing = this.conversations.get(conversationId);
    if (existing) {
      existing.lastAccessedAt = new Date();
      return existing;
    }

    const newContext: ConversationContext = {
      messages: [],
      createdAt: new Date(),
      lastAccessedAt: new Date(),
    };
    this.conversations.set(conversationId, newContext);
    return newContext;
  }

  update(conversationId: string, updates: Partial<ConversationContext>) {
    const context = this.getOrCreate(conversationId);
    Object.assign(context, updates);
    context.lastAccessedAt = new Date();
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, context] of this.conversations.entries()) {
      if (now - context.lastAccessedAt.getTime() > this.maxAge) {
        this.conversations.delete(id);
      }
    }
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.conversations.clear();
  }
}

export const conversationStore = new ConversationStore();