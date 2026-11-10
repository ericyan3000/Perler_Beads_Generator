import { getColor } from './palette';
import type { BackgroundMode, BeadProject, GenerationStyle } from './types';

// The project library keeps every project in this browser's IndexedDB, so
// starting a new pattern never throws the previous one away. Each project is
// split across three stores so the list can load without reading every
// pattern and image:
//   entries  - small summary rows (name, size, thumbnail) for the list
//   projects - the full BeadProject, in the same shape as the exported JSON
//   images   - the base image the pattern was generated from, as raw bytes
//              (an ArrayBuffer, not a Blob: WebKit/Safari refuses to store a
//              file picked from an <input> - "BlobURLs are not yet supported")

export type GenerationSettings = {
  width: number;
  maxColors: number;
  generationStyle: GenerationStyle;
  backgroundMode: BackgroundMode;
  tolerance: number;
  paletteMode: 'basic' | 'complete';
};

export type BaseImage = {
  blob: Blob;
  name: string;
  type: string;
};

export type LibraryEntry = {
  id: string;
  name: string;
  imageName: string | null;
  createdAt: string;
  updatedAt: string;
  width: number;
  height: number;
  beadCount: number;
  colorCount: number;
  thumbnail: string;
};

export type LibraryProject = {
  project: BeadProject;
  generation: GenerationSettings | null;
  image: BaseImage | null;
};

type ProjectRow = { id: string; project: BeadProject; generation: GenerationSettings | null };
type ImageRow = { id: string; data: ArrayBuffer; name: string; type: string };

const DB_NAME = 'perler-beads-generator';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const PROJECTS = 'projects';
const IMAGES = 'images';
const currentProjectKey = 'perler-beads-generator:current-project-id';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the project library.'));
  });
  // A failed open (private browsing, blocked storage) should not poison every
  // later call, so let the next call try again.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Library write was aborted.'));
  });
}

export function newProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function loadCurrentProjectId(): string | null {
  try {
    return localStorage.getItem(currentProjectKey);
  } catch {
    return null;
  }
}

export function storeCurrentProjectId(id: string): void {
  try {
    localStorage.setItem(currentProjectKey, id);
  } catch {
    // Storage blocked: the library still works for this session.
  }
}

/** True once the project holds anything worth keeping in the library. */
export function projectHasContent(project: BeadProject): boolean {
  return project.layers.some((layer) => layer.cells.some(Boolean));
}

export async function listProjects(): Promise<LibraryEntry[]> {
  const db = await openDb();
  const entries = await requestValue(db.transaction(ENTRIES).objectStore(ENTRIES).getAll() as IDBRequest<LibraryEntry[]>);
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadProject(id: string): Promise<LibraryProject | null> {
  const db = await openDb();
  const transaction = db.transaction([PROJECTS, IMAGES]);
  const [row, image] = await Promise.all([
    requestValue(transaction.objectStore(PROJECTS).get(id) as IDBRequest<ProjectRow | undefined>),
    requestValue(transaction.objectStore(IMAGES).get(id) as IDBRequest<ImageRow | undefined>),
  ]);
  if (!row) return null;
  return {
    project: row.project,
    generation: row.generation ?? null,
    image: image ? { blob: new Blob([image.data], { type: image.type }), name: image.name, type: image.type } : null,
  };
}

/**
 * Saves a project. `image` follows a three-way contract so the (possibly
 * multi-megabyte) image is only rewritten when it actually changed:
 * a BaseImage replaces it, null removes it, undefined leaves it untouched.
 */
export async function saveProject(
  id: string,
  project: BeadProject,
  generation: GenerationSettings | null,
  image: BaseImage | null | undefined,
  imageName: string | null,
): Promise<void> {
  // Everything synchronous happens before the transaction opens, so the
  // transaction never idles (and auto-commits) while we compute.
  const thumbnail = renderThumbnail(project);
  const imageData = image ? await image.blob.arrayBuffer() : null;
  const colorIds = new Set<string>();
  let beadCount = 0;
  for (const cell of project.cells) {
    if (!cell) continue;
    beadCount += 1;
    colorIds.add(cell);
  }
  const db = await openDb();
  const transaction = db.transaction([ENTRIES, PROJECTS, IMAGES], 'readwrite');
  const entries = transaction.objectStore(ENTRIES);
  const existing = await requestValue(entries.get(id) as IDBRequest<LibraryEntry | undefined>);
  const now = new Date().toISOString();
  const entry: LibraryEntry = {
    id,
    name: project.name,
    imageName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    width: project.width,
    height: project.height,
    beadCount,
    colorCount: colorIds.size,
    thumbnail,
  };
  entries.put(entry);
  transaction.objectStore(PROJECTS).put({ id, project, generation } satisfies ProjectRow);
  if (image && imageData) {
    transaction.objectStore(IMAGES).put({ id, data: imageData, name: image.name, type: image.type } satisfies ImageRow);
  }
  else if (image === null) transaction.objectStore(IMAGES).delete(id);
  await transactionDone(transaction);
  void requestPersistentStorage();
}

export async function renameProject(id: string, name: string): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction([ENTRIES, PROJECTS], 'readwrite');
  const entries = transaction.objectStore(ENTRIES);
  const projects = transaction.objectStore(PROJECTS);
  const [entry, row] = await Promise.all([
    requestValue(entries.get(id) as IDBRequest<LibraryEntry | undefined>),
    requestValue(projects.get(id) as IDBRequest<ProjectRow | undefined>),
  ]);
  if (entry) entries.put({ ...entry, name });
  if (row) projects.put({ ...row, project: { ...row.project, name } });
  await transactionDone(transaction);
}

export async function duplicateProject(id: string, name: string): Promise<string | null> {
  const db = await openDb();
  const transaction = db.transaction([ENTRIES, PROJECTS, IMAGES], 'readwrite');
  const entries = transaction.objectStore(ENTRIES);
  const projects = transaction.objectStore(PROJECTS);
  const images = transaction.objectStore(IMAGES);
  const [entry, row, image] = await Promise.all([
    requestValue(entries.get(id) as IDBRequest<LibraryEntry | undefined>),
    requestValue(projects.get(id) as IDBRequest<ProjectRow | undefined>),
    requestValue(images.get(id) as IDBRequest<ImageRow | undefined>),
  ]);
  if (!entry || !row) return null;
  const copyId = newProjectId();
  const now = new Date().toISOString();
  entries.put({ ...entry, id: copyId, name, createdAt: now, updatedAt: now });
  projects.put({ ...row, id: copyId, project: { ...row.project, name, createdAt: now, updatedAt: now } });
  if (image) images.put({ ...image, id: copyId });
  await transactionDone(transaction);
  return copyId;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction([ENTRIES, PROJECTS, IMAGES], 'readwrite');
  transaction.objectStore(ENTRIES).delete(id);
  transaction.objectStore(PROJECTS).delete(id);
  transaction.objectStore(IMAGES).delete(id);
  await transactionDone(transaction);
}

let persistRequested = false;

// Ask the browser not to evict the library under storage pressure. Browsers
// may refuse silently; this is a best-effort hint, asked once per session.
async function requestPersistentStorage(): Promise<void> {
  if (persistRequested) return;
  persistRequested = true;
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return;
    await navigator.storage?.persist?.();
  } catch {
    // Not supported; nothing to do.
  }
}

/** Renders the visible pattern, cropped to its beads, as a small PNG data URL. */
function renderThumbnail(project: BeadProject): string {
  const { width, height, cells } = project;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  cells.forEach((cell, index) => {
    if (!cell) return;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  if (maxX < 0) return '';
  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;
  const cell = Math.max(1, Math.floor(160 / Math.max(spanX, spanY)));
  const canvas = document.createElement('canvas');
  canvas.width = spanX * cell;
  canvas.height = spanY * cell;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const hexById = new Map<string, string>();
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const id = cells[y * width + x];
      if (!id) continue;
      let hex = hexById.get(id);
      if (hex === undefined) {
        hex = getColor(id)?.hex ?? '';
        hexById.set(id, hex);
      }
      if (!hex) continue;
      context.fillStyle = hex;
      context.fillRect((x - minX) * cell, (y - minY) * cell, cell, cell);
    }
  }
  return canvas.toDataURL('image/png');
}

// --- JSON edit record helpers ------------------------------------------------
// The exported edit record is the BeadProject itself; the base image and the
// generation settings ride along as two extra top-level fields so a record
// imported elsewhere restores the image too. Older records simply lack them.

export type EditRecordExtras = {
  baseImage?: { name: string; type: string; dataUrl: string };
  generationSettings?: GenerationSettings;
};

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}
