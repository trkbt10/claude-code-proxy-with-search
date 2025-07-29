import type {
  Tool as OpenAITool,
  WebSearchTool as OpenAIWebSearchTool,
} from "openai/resources/responses/responses";

export const webSearchPreviewFunction: OpenAIWebSearchTool = {
  type: "web_search_preview",
};

export const bashFunction: OpenAITool = {
  name: "bash",
  description: "サーバー上でシェルコマンドを実行し、出力を返します。",
  type: "function",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "array",
        items: { type: "string" },
        description: '実行するコマンドと引数のリスト（例: ["ls", "-la"]）',
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  strict: true,
};

export const webSearchFunction: OpenAITool = {
  name: "web_search",
  description: "指定したクエリでウェブ検索を行い、結果を返します。",
  type: "function",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "検索クエリ文字列" },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "検索対象に含めるドメインのリスト",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "検索対象から除外するドメインのリスト",
      },
      max_uses: { type: "integer", description: "ツールを呼び出せる最大回数" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
};

export const textEditorFunction: OpenAITool = {
  name: "text_editor",
  description: "指定された文字列内で検索・置換を行います。",
  type: "function",
  parameters: {
    type: "object",
    properties: {
      original: { type: "string", description: "元のテキスト" },
      search: { type: "string", description: "検索文字列または正規表現" },
      replace: { type: "string", description: "置換後の文字列" },
      flags: {
        type: "string",
        description: '正規表現フラグ（例: "g"、"i"）',
      },
    },
    required: ["original", "search", "replace"],
    additionalProperties: false,
  },
  strict: true,
};
