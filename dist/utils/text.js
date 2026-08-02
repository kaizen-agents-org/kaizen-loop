export function tailText(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return text.slice(text.length - maxLength);
}
export function tailLines(text, lines) {
    if (lines <= 0)
        return '';
    const parts = text.split('\n');
    while (parts.at(-1) === '')
        parts.pop();
    return parts.slice(-lines).join('\n');
}
//# sourceMappingURL=text.js.map