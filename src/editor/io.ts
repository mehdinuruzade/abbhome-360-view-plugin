import { stringifyCompact } from '../core/json';
import { parseConfig, resolveUrl } from '../core/parse-config';
import { FACADES, type BuildingConfig, type FacadeId } from '../core/types';
import { withEditor, type WithEditor } from './state';

/**
 * A facade image as the editor knows it. `ref` is what goes into the exported JSON (a file name
 * next to building.json, or a URL); `src` is something the browser can show right now, or null
 * when a local file has to be picked again (after a reload or an import).
 */
export interface ImageRef {
  ref: string;
  src: string | null;
  width: number;
  height: number;
}

/**
 * The config keeps every path exactly as written (portable); `baseUrl`, when the config came
 * from a URL, is only used to display relative paths in the editor.
 */
export interface EditorDocument {
  config: WithEditor;
  images: Record<FacadeId, ImageRef>;
  baseUrl?: string;
}

export const STORAGE_KEY = 'abb360-editor-v1';

const displayable = (url: string) => /^(https?:|data:|blob:)/i.test(url);

export function emptyImages(): Record<FacadeId, ImageRef> {
  const images = {} as Record<FacadeId, ImageRef>;
  for (const f of FACADES) images[f] = { ref: '', src: null, width: 0, height: 0 };
  return images;
}

/** The config with every facade image set to its exportable reference. */
export function exportConfig(doc: EditorDocument): BuildingConfig {
  const facades = { ...doc.config.facades };
  for (const f of FACADES) facades[f] = { ...facades[f], image: doc.images[f].ref };
  return { ...doc.config, facades };
}

export function serialize(doc: EditorDocument): string {
  return stringifyCompact(exportConfig(doc));
}

/**
 * Reads a building.json. `baseUrl` (when the file came from a URL) makes relative image paths
 * displayable; without it, relative paths are file names the user picks again.
 */
export function importConfig(raw: unknown, baseUrl?: string): { doc: EditorDocument; warnings: string[] } {
  const { config, warnings } = parseConfig(raw);
  const images = emptyImages();
  for (const f of FACADES) {
    const ref = config.facades[f].image;
    const resolved = resolveUrl(ref, baseUrl);
    images[f] = { ref, src: resolved && displayable(resolved) ? resolved : null, width: 0, height: 0 };
  }
  return { doc: { config: withEditor(config), images, ...(baseUrl ? { baseUrl } : {}) }, warnings };
}

/** Saves the draft; local (blob) images are kept by name only. False if storage is unavailable or full. */
export function saveDraft(doc: EditorDocument, storage: Storage | undefined = globalThis.localStorage): boolean {
  if (!storage) return false;
  const images = {} as Record<FacadeId, ImageRef>;
  for (const f of FACADES) {
    const img = doc.images[f];
    images[f] = { ...img, src: img.src && /^(https?:|data:)/i.test(img.src) && img.src.length < 200_000 ? img.src : null };
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ config: doc.config, images, baseUrl: doc.baseUrl }));
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(storage: Storage | undefined = globalThis.localStorage): EditorDocument | null {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    if (!text) return null;
    const saved = JSON.parse(text) as { config: unknown; images?: Partial<Record<FacadeId, ImageRef>>; baseUrl?: unknown };
    const config = withEditor(parseConfig(saved.config).config);
    const images = emptyImages();
    for (const f of FACADES) {
      const img = saved.images?.[f];
      if (img && typeof img.ref === 'string') {
        images[f] = { ref: img.ref, src: typeof img.src === 'string' ? img.src : null, width: Number(img.width) || 0, height: Number(img.height) || 0 };
      }
    }
    return { config, images, ...(typeof saved.baseUrl === 'string' ? { baseUrl: saved.baseUrl } : {}) };
  } catch {
    return null;
  }
}

export function clearDraft(storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: nothing to clear.
  }
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
