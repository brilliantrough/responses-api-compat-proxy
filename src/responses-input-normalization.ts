export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonRecord = { [key: string]: JsonValue };

export type NormalizeInputOptions = {
  clearDeveloperContent?: boolean;
  clearSystemContent?: boolean;
  convertSystemToDeveloper?: boolean;
};

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeMessageContent(role: string, content: JsonValue): JsonValue {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return content;
  }

  return content.map(part => {
    if (!isJsonRecord(part) || typeof part.type !== 'string') {
      return part;
    }

    if (role === 'assistant' && part.type === 'input_text' && typeof part.text === 'string') {
      return {
        ...part,
        type: 'output_text',
      };
    }

    if (role !== 'assistant' && part.type === 'output_text' && typeof part.text === 'string') {
      const { annotations: _annotations, ...rest } = part;
      return {
        ...rest,
        type: 'input_text',
      };
    }

    return part;
  });
}

function clearDeveloperMessageContent(content: JsonValue): JsonValue {
  if (typeof content === 'string') {
    return '';
  }

  if (!Array.isArray(content)) {
    if (!isJsonRecord(content)) {
      return content;
    }

    if (typeof content.text === 'string') {
      return {
        ...content,
        text: '',
      };
    }

    return content;
  }

  return content.map(part => {
    if (!isJsonRecord(part)) {
      return part;
    }

    if (typeof part.text === 'string') {
      return {
        ...part,
        text: '',
      };
    }

    return part;
  });
}

function shouldClearMessageContent(role: string, options: NormalizeInputOptions) {
  return (role === 'developer' && options.clearDeveloperContent) || (role === 'system' && options.clearSystemContent);
}

function normalizeMessageRole(role: string, options: NormalizeInputOptions) {
  if (role === 'system' && options.convertSystemToDeveloper !== false) {
    return 'developer';
  }

  return role;
}

export function normalizeInput(input: JsonValue | undefined, options: NormalizeInputOptions = {}): JsonValue {
  if (typeof input === 'string') {
    return [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: input }],
      },
    ];
  }

  if (!Array.isArray(input)) {
    return input ?? [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '' }],
      },
    ];
  }

  return input.map(item => {
    if (!isJsonRecord(item)) {
      return item;
    }

    if (typeof item.role !== 'string') {
      return item;
    }

    const normalizedRole = normalizeMessageRole(item.role, options);
    const normalizedContent = shouldClearMessageContent(item.role, options)
      ? clearDeveloperMessageContent(item.content)
      : normalizeMessageContent(normalizedRole, item.content);

    if (typeof item.content === 'string') {
      return {
        ...item,
        role: normalizedRole,
        type: typeof item.type === 'string' ? item.type : 'message',
        content: normalizedContent,
      };
    }

    return {
      ...item,
      role: normalizedRole,
      type: typeof item.type === 'string' ? item.type : 'message',
      ...(item.content === undefined
        ? {}
        : { content: normalizedContent }),
    };
  });
}
