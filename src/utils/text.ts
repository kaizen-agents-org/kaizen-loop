export function tailText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}

export function tailLines(text: string, lines: number): string {
  return text.split('\n').slice(-lines).join('\n');
}
