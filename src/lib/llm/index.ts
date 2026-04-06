// LLM Provider Abstraction Layer for Agillo Planning Poker

export interface JSONSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  description?: string;
  enum?: (string | number | boolean | null)[];
}

export interface LLMProvider {
  generateStructured<T>(prompt: string, schema: JSONSchema): Promise<T>;
}

// Gemini Provider (uses @google/genai)
export class GeminiProvider implements LLMProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateStructured<T>(prompt: string, schema: JSONSchema): Promise<T> {
    // Dynamic import to avoid loading the library if not used
    const { GoogleGenAI, Type } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: this.apiKey });

    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: this.convertSchemaToGemini(schema)
      }
    });

    return JSON.parse(response.text || "{}") as T;
  }

  private convertSchemaToGemini(schema: JSONSchema): any {
    const { Type } = require('@google/genai');

    const convertType = (type: JSONSchema['type']): any => {
      switch (type) {
        case 'string': return Type.STRING;
        case 'number': return Type.NUMBER;
        case 'boolean': return Type.BOOLEAN;
        case 'object': return Type.OBJECT;
        case 'array': return Type.ARRAY;
        case 'null': return Type.NULL;
        default: return Type.STRING;
      }
    };

    if (schema.type === 'array' && schema.items) {
      return {
        type: Type.ARRAY,
        items: this.convertSchemaToGemini(schema.items)
      };
    }

    if (schema.type === 'object' && schema.properties) {
      const convertedProperties: Record<string, any> = {};
      const requiredFields: string[] = [];

      for (const [key, value] of Object.entries(schema.properties)) {
        convertedProperties[key] = this.convertSchemaToGemini(value);
        if (schema.required?.includes(key)) {
          requiredFields.push(key);
        }
      }

      return {
        type: Type.OBJECT,
        properties: convertedProperties,
        required: requiredFields
      };
    }

    return { type: convertType(schema.type) };
  }
}

// Anthropic Provider (uses @anthropic-ai/sdk)
export class AnthropicProvider implements LLMProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateStructured<T>(prompt: string, schema: JSONSchema): Promise<T> {
    const Anthropic = await import('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: this.apiKey });

    const response = await client.messages.create({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      tools: [{
        name: "generate_response",
        description: "Generate a structured JSON response",
        input_schema: {
          type: "object" as const,
          properties: {
            result: schema
          },
          required: ["result"]
        }
      }],
      tool_choice: { type: "tool", name: "generate_response" }
    });

    // Find tool_use block using type assertion
    const toolUseBlock = response.content.find((block) => block.type === 'tool_use') as any;

    if (!toolUseBlock || !toolUseBlock.input || !toolUseBlock.input.result) {
      throw new Error('No valid tool use in response');
    }

    return toolUseBlock.input.result as T;
  }
}

// ZAI Provider (uses OpenAI-compatible API)
export class ZAIProvider implements LLMProvider {
  private apiKey: string;
  private baseURL: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseURL = "https://api.zai.chat/v1";
  }

  async generateStructured<T>(prompt: string, schema: JSONSchema): Promise<T> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL
    });

    const response = await client.chat.completions.create({
      model: "zai/glm-5",
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: schema as any
        }
      }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No content in response');
    }

    return JSON.parse(content) as T;
  }
}

// MiniMax Provider (uses OpenAI-compatible API)
export class MiniMaxProvider implements LLMProvider {
  private apiKey: string;
  private baseURL: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseURL = "https://api.minimaxi.chat/v1";
  }

  async generateStructured<T>(prompt: string, schema: JSONSchema): Promise<T> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL
    });

    const response = await client.chat.completions.create({
      model: "MiniMax-M2.7",
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: schema as any
        }
      }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No content in response');
    }

    return JSON.parse(content) as T;
  }
}

// Factory function to create the appropriate provider
export function createLLMProvider(): LLMProvider {
  const provider = process.env.LLM_PROVIDER || 'gemini';

  switch (provider.toLowerCase()) {
    case 'gemini':
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) throw new Error('GEMINI_API_KEY environment variable is required for Gemini provider');
      return new GeminiProvider(geminiKey);

    case 'anthropic':
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY environment variable is required for Anthropic provider');
      return new AnthropicProvider(anthropicKey);

    case 'zai':
      const zaiKey = process.env.ZAI_API_KEY;
      if (!zaiKey) throw new Error('ZAI_API_KEY environment variable is required for ZAI provider');
      return new ZAIProvider(zaiKey);

    case 'minimax':
      const minimaxKey = process.env.MINIMAX_API_KEY;
      if (!minimaxKey) throw new Error('MINIMAX_API_KEY environment variable is required for MiniMax provider');
      return new MiniMaxProvider(minimaxKey);

    default:
      throw new Error(`Unknown LLM provider: ${provider}. Supported providers: gemini, anthropic, zai, minimax`);
  }
}
