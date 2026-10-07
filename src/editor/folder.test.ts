import { describe, expect, it } from 'vitest';
import { assignPhotos, findConfig, isImage, relativeToFolder, wallFromName, type FolderEntry } from './folder';

const entries = (...paths: string[]): FolderEntry<string>[] => paths.map((path) => ({ file: path, path }));
const names = (a: ReturnType<typeof assignPhotos<string>>) => ({
  front: a.walls.front?.path,
  right: a.walls.right?.path,
  back: a.walls.back?.path,
  left: a.walls.left?.path,
});

describe('opening a folder', () => {
  it('knows photos from everything else', () => {
    expect(isImage('1 front.JPG')).toBe(true);
    expect(isImage('assets/back.webp')).toBe(true);
    expect(isImage('scan', 'image/heic')).toBe(true);
    expect(isImage('.DS_Store')).toBe(false);
    expect(isImage('._1 front.jpg')).toBe(false);
    expect(isImage('__MACOSX/1 front.jpg')).toBe(false);
    expect(isImage('notes.txt')).toBe(false);
    expect(isImage('plan.svg', 'image/svg+xml')).toBe(false);
  });

  it('drops the chosen folder from the paths', () => {
    expect(relativeToFolder(['Tower/1 front.jpg', 'Tower/assets/b.webp'])).toEqual(['1 front.jpg', 'assets/b.webp']);
    expect(relativeToFolder(['a.jpg', 'b.jpg'])).toEqual(['a.jpg', 'b.jpg']);
  });

  it('reads the wall from a name', () => {
    expect(wallFromName('1 front.jpg')).toBe('front');
    expect(wallFromName('Back.PNG')).toBe('back');
    expect(wallFromName('facade-left.webp')).toBe('left');
    expect(wallFromName('rear_view.jpg')).toBe('back');
    expect(wallFromName('2.jpg')).toBe('right');
    expect(wallFromName('04 - side.jpg')).toBe('left');
    expect(wallFromName('frontier.jpg')).toBeNull();
    expect(wallFromName('12.jpg')).toBeNull();
  });

  it('puts named photos on their walls whatever the order', () => {
    const a = assignPhotos(entries('left.jpg', 'Front.jpg', 'back.jpg', 'right.jpg'));
    expect(names(a)).toEqual({ front: 'Front.jpg', right: 'right.jpg', back: 'back.jpg', left: 'left.jpg' });
    expect(a.skipped).toEqual([]);
  });

  it('falls back to name order, numbers sorted as numbers', () => {
    const a = assignPhotos(entries('IMG_10.jpg', 'IMG_9.jpg', 'IMG_11.jpg', 'IMG_12.jpg', 'IMG_13.jpg'));
    expect(names(a)).toEqual({ front: 'IMG_9.jpg', right: 'IMG_10.jpg', back: 'IMG_11.jpg', left: 'IMG_12.jpg' });
    expect(a.skipped.map((e) => e.path)).toEqual(['IMG_13.jpg']);
  });

  it('matches an imported config by path, then by file name', () => {
    const a = assignPhotos(entries('assets/front.webp', 'photos/right.webp', 'x.webp', 'y.webp'), {
      front: 'assets/front.webp',
      right: 'img/right.webp',
      back: 'https://cdn.example.com/back.webp',
    });
    expect(a.walls.front?.path).toBe('assets/front.webp');
    expect(a.walls.right?.path).toBe('photos/right.webp');
    // The back is a URL: the folder's leftovers fill the free walls in order.
    expect(a.walls.back?.path).toBe('x.webp');
    expect(a.walls.left?.path).toBe('y.webp');
  });

  it('finds the building config: building.json first, the shallowest otherwise', () => {
    expect(findConfig(entries('assets/a.json', 'other.json', 'building.json'))?.path).toBe('building.json');
    expect(findConfig(entries('deep/building.json', 'tower.json'))?.path).toBe('tower.json');
    expect(findConfig(entries('a.jpg', '.hidden.json'))).toBeNull();
  });
});
