export function extractLastJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidates = fenced.length > 0 ? fenced.map((match) => match[1]) : [text];

  for (const candidate of candidates.reverse()) {
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      const start = trimmed.lastIndexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          continue;
        }
      }
    }
  }

  throw new Error('No parseable JSON object found');
}
