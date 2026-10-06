/**
 * JSON with short arrays and objects kept on one line, so a config with hundreds of polygons
 * stays readable and diffs stay small. Output parses to exactly the same value as JSON.stringify.
 */
export function stringifyCompact(value: unknown, maxInline = 100): string {
  return write(value, '', maxInline) + '\n';
}

function inline(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(', ')}}`;
}

function write(value: unknown, indent: string, maxInline: number): string {
  const next = indent + '  ';
  if (value !== null && typeof value === 'object') {
    const flat = inline(value);
    if (flat.length + indent.length <= maxInline) return flat;
  }
  if (Array.isArray(value)) {
    return `[\n${value.map((v) => next + write(v, next, maxInline)).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    const body = entries
      .map(([k, v]) => `${next}${JSON.stringify(k)}: ${write(v, next, maxInline)}`)
      .join(',\n');
    return `{\n${body}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
