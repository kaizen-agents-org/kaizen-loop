export function tailText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}

export function tailLines(text: string, lines: number): string {
  if (lines <= 0) return '';
  const parts = text.split('\n');
  while (parts.at(-1) === '') parts.pop();
  return parts.slice(-lines).join('\n');
}
