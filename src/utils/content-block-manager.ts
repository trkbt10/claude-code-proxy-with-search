/**
 * Manages content blocks for a stream, automatically handling indices
 */
export interface ContentBlock {
  id: string;
  type: 'text' | 'tool_use';
  index: number;
  started: boolean;
  completed: boolean;
}

export interface TextBlock extends ContentBlock {
  type: 'text';
}

export interface ToolBlock extends ContentBlock {
  type: 'tool_use';
  name: string;
  argsBuffer: string;
  call_id?: string;
}

export class ContentBlockManager {
  private blocks: ContentBlock[] = [];
  private blockMap: Map<string, ContentBlock> = new Map();

  /**
   * Add a new text block and return its index
   */
  addTextBlock(): TextBlock {
    const index = this.blocks.length;
    const id = `text_${index}`;
    const block: TextBlock = {
      id,
      type: 'text',
      index,
      started: false,
      completed: false,
    };
    this.blocks.push(block);
    this.blockMap.set(id, block);
    return block;
  }

  /**
   * Add a new tool block and return its index
   */
  addToolBlock(toolId: string, name: string, call_id?: string): ToolBlock {
    // Check if already exists
    const existing = this.blockMap.get(toolId);
    if (existing && existing.type === 'tool_use') {
      return existing as ToolBlock;
    }

    const index = this.blocks.length;
    const block: ToolBlock = {
      id: toolId,
      type: 'tool_use',
      index,
      name,
      argsBuffer: '',
      call_id,
      started: false,
      completed: false,
    };
    this.blocks.push(block);
    this.blockMap.set(toolId, block);
    return block;
  }

  /**
   * Get a block by ID
   */
  getBlock(id: string): ContentBlock | undefined {
    return this.blockMap.get(id);
  }

  /**
   * Get a tool block by ID
   */
  getToolBlock(id: string): ToolBlock | undefined {
    const block = this.blockMap.get(id);
    return block?.type === 'tool_use' ? (block as ToolBlock) : undefined;
  }

  /**
   * Get the current text block (last added text block that's not completed)
   */
  getCurrentTextBlock(): TextBlock | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      if (block.type === 'text' && !block.completed) {
        return block as TextBlock;
      }
    }
    return undefined;
  }

  /**
   * Mark a block as started
   */
  markStarted(id: string): void {
    const block = this.blockMap.get(id);
    if (block) {
      block.started = true;
    }
  }

  /**
   * Mark a block as completed
   */
  markCompleted(id: string): void {
    const block = this.blockMap.get(id);
    if (block) {
      block.completed = true;
    }
  }

  /**
   * Get all blocks
   */
  getAllBlocks(): ContentBlock[] {
    return [...this.blocks];
  }

  /**
   * Check if there are any active tool blocks
   */
  hasActiveTools(): boolean {
    return this.blocks.some(
      block => block.type === 'tool_use' && !block.completed
    );
  }

  /**
   * Get all uncompleted blocks
   */
  getUncompletedBlocks(): ContentBlock[] {
    return this.blocks.filter(block => !block.completed);
  }
}