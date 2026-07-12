export function extractLastJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidates = fenced.length > 0 ? fenced.map((match) => match[1]) : [text];

  for (const candidate of candidates.reverse()) {
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      for (const json of jsonObjects(trimmed).reverse()) {
        try {
          return JSON.parse(json);
        } catch {
          continue;
        }
      }
    }
  }

  throw new Error('No parseable JSON object found');
}

function jsonObjects(text: string): string[] {
  const objects: string[] = [];
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && starts.length > 0) inString = true;
    else if (char === '{') starts.push(index);
    else if (char === '}' && starts.length > 0) {
      const start = starts.pop();
      if (start !== undefined) objects.push(text.slice(start, index + 1));
    }
  }
  return objects;
}
