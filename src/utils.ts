export function parseTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags as string[];
  if (typeof tags === 'string') {
    if (tags.startsWith('[')) {
      try { return JSON.parse(tags); } catch { return [tags]; }
    }
    return tags.split(',').map(t => t.trim()).filter(Boolean);
  }
  return [];
}
