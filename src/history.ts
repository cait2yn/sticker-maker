// Past stickers, kept in this browser's IndexedDB. Each record holds the
// cut-out (so the background never has to be removed again), the settings
// it was last left at, and a small thumbnail.

export interface Settings {
  cut: 'angular' | 'smooth'
  border: number
  white: boolean
  mono: boolean
  shards: number
  holo: number
}

export interface Saved {
  id: number
  created: number
  cutout: Blob
  thumb: Blob
  settings: Settings
  demo?: string // set on the built-in example sticker
}

const DB = 'holo-sticker'
const STORE = 'stickers'

let dbp: Promise<IDBDatabase> | null = null
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const s = (await db()).transaction(STORE, mode).objectStore(STORE)
  return new Promise((resolve, reject) => {
    const req = fn(s)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function listSaved(): Promise<Saved[]> {
  const all = await run<Saved[]>('readonly', (s) => s.getAll())
  return all.sort((a, b) => b.created - a.created)
}

export const addSaved = (rec: Omit<Saved, 'id'>) => run<IDBValidKey>('readwrite', (s) => s.add(rec)) as Promise<number>

export async function updateSaved(id: number, patch: Partial<Saved>) {
  const rec = await run<Saved | undefined>('readonly', (s) => s.get(id))
  if (rec) await run('readwrite', (s) => s.put({ ...rec, ...patch }))
}

export const removeSaved = (id: number) => run('readwrite', (s) => s.delete(id))
