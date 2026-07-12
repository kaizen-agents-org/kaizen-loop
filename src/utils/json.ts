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
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const char = text[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        objects.push(text.slice(start, end + 1));
        start = end;
        break;
      }
    }
  }
  return objects;
}
