import { describe, expect, it } from 'vitest';
import { buildDemoConfig } from '../../scripts/demo-config';
import { exportConfig, importConfig, loadDraft, saveDraft, serialize } from './io';

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

describe('editor import / export', () => {
  const raw = JSON.parse(JSON.stringify(buildDemoConfig()));

  it('keeps relative paths for export and resolves facade images for display', () => {
    const { doc } = importConfig(raw, 'https://cdn.example.com/b/building.json');
    expect(doc.images.front.ref).toBe('assets/front.webp');
    expect(doc.images.front.src).toBe('https://cdn.example.com/b/assets/front.webp');
    expect(doc.baseUrl).toBe('https://cdn.example.com/b/building.json');
    const exported = exportConfig(doc);
    expect(exported.facades.front.image).toBe('assets/front.webp');
    expect(exported.apartments[0]?.planImage).toBe('assets/plans/plan-3-room.svg');
  });

  it('exports exactly what was imported when nothing changed', () => {
    const { doc } = importConfig(raw, 'https://cdn.example.com/b/building.json');
    expect(JSON.parse(serialize(doc))).toEqual(raw);
  });

  it('marks relative images as needing a file when there is no base URL', () => {
    const { doc } = importConfig(raw);
    expect(doc.images.left.src).toBeNull();
    expect(doc.images.left.ref).toBe('assets/left.webp');
  });

  it('round-trips the demo config through export and import', () => {
    const { doc } = importConfig(raw);
    const again = importConfig(JSON.parse(serialize(doc))).doc;
    expect(again.config).toEqual(doc.config);
  });

  it('saves drafts without blob URLs and restores them', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    const { doc } = importConfig(raw, 'https://cdn.example.com/b/building.json');
    doc.images.back = { ref: 'back-photo.jpg', src: 'blob:https://x/123', width: 10, height: 20 };
    expect(saveDraft(doc, storage)).toBe(true);
    const restored = loadDraft(storage);
    expect(restored?.images.back).toEqual({ ref: 'back-photo.jpg', src: null, width: 10, height: 20 });
    expect(restored?.images.front.src).toBe('https://cdn.example.com/b/assets/front.webp');
    expect(restored?.config.apartments).toHaveLength(104);
  });

  it('returns null for a missing or corrupt draft', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    expect(loadDraft(storage)).toBeNull();
    storage.setItem('abb360-editor-v1', '{not json');
    expect(loadDraft(storage)).toBeNull();
  });
});
