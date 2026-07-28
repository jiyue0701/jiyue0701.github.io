type StorageAdapter = {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
}

const DB_NAME = 'glute-training-mvp'
const STORE_NAME = 'key-value'

const memoryStore = new Map<string, unknown>()

function createIndexedDbAdapter(): StorageAdapter | null {
  if (typeof indexedDB === 'undefined') return null

  let databasePromise: Promise<IDBDatabase> | null = null
  const openDatabase = () => {
    if (databasePromise) return databasePromise
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return databasePromise
  }

  return {
    async get<T>(key: string) {
      try {
        const db = await openDatabase()
        return await new Promise<T | null>((resolve, reject) => {
          const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
          request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
          request.onerror = () => reject(request.error)
        })
      } catch {
        return null
      }
    },
    async set<T>(key: string, value: T) {
      try {
        const db = await openDatabase()
        await new Promise<void>((resolve, reject) => {
          const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, key)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
        })
      } catch {
        memoryStore.set(key, value)
      }
    },
    async remove(key: string) {
      try {
        const db = await openDatabase()
        await new Promise<void>((resolve, reject) => {
          const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(key)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
        })
      } catch {
        memoryStore.delete(key)
      }
    },
  }
}

function createLocalStorageAdapter(): StorageAdapter {
  const canUseLocalStorage = typeof localStorage !== 'undefined'

  return {
    async get<T>(key: string) {
      try {
        const raw = canUseLocalStorage ? localStorage.getItem(key) : null
        return raw ? (JSON.parse(raw) as T) : ((memoryStore.get(key) as T | undefined) ?? null)
      } catch {
        return (memoryStore.get(key) as T | undefined) ?? null
      }
    },
    async set<T>(key: string, value: T) {
      memoryStore.set(key, value)
      try {
        if (canUseLocalStorage) localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Private browsing or a full quota can disable localStorage; memory remains available.
      }
    },
    async remove(key: string) {
      memoryStore.delete(key)
      try {
        if (canUseLocalStorage) localStorage.removeItem(key)
      } catch {
        // Best-effort fallback.
      }
    },
  }
}

export const storage: StorageAdapter = createIndexedDbAdapter() ?? createLocalStorageAdapter()

export const STORAGE_KEYS = {
  lastSession: 'last-completed-session',
  sessions: 'completed-sessions',
  plans: 'saved-plans',
} as const
