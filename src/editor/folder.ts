import { FACADES, type FacadeId } from '../core/types';

/**
 * Opening a folder in the editor: which files are photos, which one is a building config, and
 * which photo goes on which wall. Pure functions over file names, so they run in tests.
 */

export interface FolderEntry<F = File> {
  file: F;
  /** Path inside the chosen folder, '/'-separated, without the folder's own name. */
  path: string;
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif']);

/** The base name of a path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Hidden and system files every OS leaves in folders. */
export function isJunk(path: string): boolean {
  return path.split('/').some((part) => part.startsWith('.') || part.startsWith('__MACOSX')) || /^(thumbs\.db|desktop\.ini)$/i.test(baseName(path));
}

export function isImage(path: string, type = ''): boolean {
  if (isJunk(path)) return false;
  if (type.startsWith('image/') && type !== 'image/svg+xml') return true;
  const ext = baseName(path).split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Strips the chosen folder's own name from a `webkitRelativePath` ("Building A/1 front.jpg" →
 * "1 front.jpg"), so paths read like the refs in an exported building.json.
 */
export function relativeToFolder(paths: readonly string[]): string[] {
  const split = paths.map((p) => p.split('/'));
  const first = split[0]?.[0];
  const shared = first !== undefined && split.every((parts) => parts.length > 1 && parts[0] === first);
  return split.map((parts) => (shared ? parts.slice(1) : parts).join('/'));
}

/** The building config in a folder: building.json first, else the shallowest .json. */
export function findConfig<F>(entries: readonly FolderEntry<F>[]): FolderEntry<F> | null {
  const json = entries.filter((e) => !isJunk(e.path) && /\.json$/i.test(e.path));
  const depth = (e: FolderEntry<F>) => e.path.split('/').length;
  json.sort((a, b) => depth(a) - depth(b) || Number(baseName(b.path).toLowerCase() === 'building.json') - Number(baseName(a.path).toLowerCase() === 'building.json') || a.path.localeCompare(b.path));
  return json[0] ?? null;
}

const WALL_WORDS: Record<FacadeId, RegExp> = {
  front: /(^|[^a-z])front([^a-z]|$)/i,
  right: /(^|[^a-z])right([^a-z]|$)/i,
  back: /(^|[^a-z])(back|rear)([^a-z]|$)/i,
  left: /(^|[^a-z])left([^a-z]|$)/i,
};

/** The wall a file name names: a wall word, or 1–4 as its leading number ("2.jpg", "3 back"). */
export function wallFromName(path: string): FacadeId | null {
  const name = baseName(path).replace(/\.[^.]+$/, '');
  const byWord = FACADES.filter((f) => WALL_WORDS[f].test(name));
  if (byWord.length === 1) return byWord[0] as FacadeId;
  const lead = /^\s*0*([1-4])(?!\d)/.exec(name);
  return lead ? (FACADES[Number(lead[1]) - 1] as FacadeId) : null;
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export interface PhotoAssignment<F> {
  walls: Partial<Record<FacadeId, FolderEntry<F>>>;
  /** Images left over (more than four, or two for the same wall). */
  skipped: FolderEntry<F>[];
}

/**
 * Puts the images on walls: first by the refs an imported config names (exact path, else the
 * same file name), then by wall words or leading numbers in the names, then the rest in name
 * order onto the walls still free.
 */
export function assignPhotos<F>(
  entries: readonly FolderEntry<F>[],
  knownRefs: Partial<Record<FacadeId, string>> = {},
): PhotoAssignment<F> {
  const images = [...entries].sort((a, b) => natural(a.path, b.path));
  const walls: Partial<Record<FacadeId, FolderEntry<F>>> = {};
  const used = new Set<FolderEntry<F>>();
  const take = (f: FacadeId, e: FolderEntry<F> | undefined) => {
    if (!e || walls[f] || used.has(e)) return;
    walls[f] = e;
    used.add(e);
  };

  for (const f of FACADES) {
    const ref = knownRefs[f]?.replace(/^\.\//, '');
    if (!ref || /^(https?:|data:|blob:)/i.test(ref)) continue;
    take(f, images.find((e) => e.path === ref) ?? images.find((e) => !used.has(e) && baseName(e.path) === baseName(ref)));
  }
  for (const e of images) {
    const f = wallFromName(e.path);
    if (f) take(f, e);
  }
  for (const f of FACADES) take(f, images.find((e) => !used.has(e)));
  return { walls, skipped: images.filter((e) => !used.has(e)) };
}

/**
 * What was dropped on the page, folders walked recursively. Call it from the drop handler before
 * any await: the browser only lets the event's items be read while the event is dispatching.
 */
export function droppedEntries(dt: DataTransfer): Promise<FolderEntry[]> {
  const roots = [...dt.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((e): e is FileSystemEntry => e !== null);
  const files = [...dt.files];
  return (async () => {
    if (!roots.length) return files.map((file) => ({ file, path: file.name }));
    const out: FolderEntry[] = [];
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        out.push({ file, path: prefix + entry.name });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // readEntries hands out a directory in batches until it returns an empty one.
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
        }
      }
    };
    for (const root of roots) await walk(root, '');
    const paths = relativeToFolder(out.map((e) => e.path));
    return out.map((e, i) => ({ file: e.file, path: paths[i] ?? e.path }));
  })();
}

/** Files from a picker (folder or multi-select), with paths relative to the chosen folder. */
export function pickedEntries(files: FileList | readonly File[]): FolderEntry[] {
  const list = [...files];
  const paths = relativeToFolder(list.map((f) => f.webkitRelativePath || f.name));
  return list.map((file, i) => ({ file, path: paths[i] ?? file.name }));
}
