export type StorageMutationResult = {
  backend: string
  persisted: boolean
  fallbackUsed: boolean
  failedBackends: string[]
}

export type StorageAdapter = {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<StorageMutationResult>
  remove(key: string): Promise<StorageMutationResult>
}

export type StorageBackend = {
  name: string
  persistent: boolean
  get(key: string): Promise<unknown | null>
  set(key: string, value: unknown): Promise<void>
}

export type LocalStorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

type StorageEnvelope = {
  __workoutStorage: 1
  revision: number
  deleted: boolean
  value?: unknown
}

const DB_NAME = 'glute-training-mvp'
const STORE_NAME = 'key-value'
const ENVELOPE_MARKER = 1

function asEnvelope(value: unknown): StorageEnvelope | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (
    candidate.__workoutStorage !== ENVELOPE_MARKER
    || !Number.isSafeInteger(candidate.revision)
    || (candidate.revision as number) < 0
    || typeof candidate.deleted !== 'boolean'
  ) return null
  return candidate as StorageEnvelope
}

function decodeStoredValue(value: unknown) {
  const envelope = asEnvelope(value)
  return envelope ?? { __workoutStorage: 1 as const, revision: 0, deleted: false, value }
}

export function createMemoryStorageBackend(store = new Map<string, unknown>()): StorageBackend {
  return {
    name: 'memory',
    persistent: false,
    async get(key) {
      return store.has(key) ? store.get(key) ?? null : null
    },
    async set(key, value) {
      store.set(key, value)
    },
  }
}

export function createLocalStorageBackend(local: LocalStorageLike): StorageBackend {
  return {
    name: 'localStorage',
    persistent: true,
    async get(key) {
      const raw = local.getItem(key)
      return raw === null ? null : JSON.parse(raw)
    },
    async set(key, value) {
      local.setItem(key, JSON.stringify(value))
    },
  }
}

export function createIndexedDbStorageBackend(factory: IDBFactory): StorageBackend {
  let databasePromise: Promise<IDBDatabase> | null = null

  const openDatabase = () => {
    if (databasePromise) return databasePromise
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest
      try {
        request = factory.open(DB_NAME, 1)
      } catch (error) {
        reject(error)
        return
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
      request.onblocked = () => reject(new Error('IndexedDB open blocked'))
    }).catch((error) => {
      databasePromise = null
      throw error
    })
    return databasePromise
  }

  const runRequest = async <T>(mode: IDBTransactionMode, createRequest: (store: IDBObjectStore) => IDBRequest<T>) => {
    const database = await openDatabase()
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction
      let request: IDBRequest<T>
      try {
        transaction = database.transaction(STORE_NAME, mode)
        request = createRequest(transaction.objectStore(STORE_NAME))
      } catch (error) {
        reject(error)
        return
      }
      let result: T
      request.onsuccess = () => { result = request.result }
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    })
  }

  return {
    name: 'indexedDB',
    persistent: true,
    async get(key) {
      const value = await runRequest('readonly', (store) => store.get(key))
      return value ?? null
    },
    async set(key, value) {
      await runRequest('readwrite', (store) => store.put(value, key))
    },
  }
}

export function createFallbackStorageAdapter(backends: readonly StorageBackend[]): StorageAdapter {
  if (!backends.length) throw new Error('at least one storage backend is required')
  let lastIssuedRevision = 0

  const readCandidates = async (key: string) => {
    const candidates: StorageEnvelope[] = []
    for (const backend of backends) {
      try {
        const stored = await backend.get(key)
        if (stored !== null) candidates.push(decodeStoredValue(stored))
      } catch {
        // Continue through the persistent fallback chain, then memory.
      }
    }
    return candidates
  }

  const preferCandidate = (selected: StorageEnvelope, candidate: StorageEnvelope) => {
    if (candidate.revision !== selected.revision) return candidate.revision > selected.revision ? candidate : selected
    return candidate.deleted && !selected.deleted ? candidate : selected
  }

  const nextRevision = async (key: string) => {
    const candidates = await readCandidates(key)
    const observedRevision = candidates.reduce((maximum, candidate) => Math.max(maximum, candidate.revision), 0)
    const now = Date.now()
    const timeRevision = Number.isSafeInteger(now) && now >= 0 && now <= Math.floor((Number.MAX_SAFE_INTEGER - 1) / 1_000)
      ? now * 1_000
      : 0
    const floor = Math.max(observedRevision, lastIssuedRevision, timeRevision)
    if (floor >= Number.MAX_SAFE_INTEGER) throw new Error('storage revision exhausted')
    lastIssuedRevision = floor + 1
    return lastIssuedRevision
  }

  const writeEnvelope = async (key: string, envelope: StorageEnvelope): Promise<StorageMutationResult> => {
    const failedBackends: string[] = []
    const successfulBackends: StorageBackend[] = []
    for (const backend of backends) {
      try {
        await backend.set(key, envelope)
        successfulBackends.push(backend)
      } catch {
        failedBackends.push(backend.name)
      }
    }
    if (!successfulBackends.length) throw new Error(`storage write failed: ${failedBackends.join(', ')}`)
    const selected = successfulBackends.find((backend) => backend.persistent) ?? successfulBackends[0]
    return {
      backend: selected.name,
      persisted: successfulBackends.some((backend) => backend.persistent),
      fallbackUsed: failedBackends.length > 0 || selected !== backends[0],
      failedBackends,
    }
  }

  return {
    async get<T>(key: string) {
      const candidates = await readCandidates(key)
      if (!candidates.length) return null
      const latest = candidates.reduce(preferCandidate)
      return latest.deleted ? null : (latest.value as T ?? null)
    },
    async set<T>(key: string, value: T) {
      return writeEnvelope(key, {
        __workoutStorage: 1,
        revision: await nextRevision(key),
        deleted: false,
        value,
      })
    },
    async remove(key: string) {
      return writeEnvelope(key, {
        __workoutStorage: 1,
        revision: await nextRevision(key),
        deleted: true,
      })
    },
  }
}

function resolveIndexedDbFactory() {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB
  } catch {
    return null
  }
}

function resolveLocalStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const storageBackends: StorageBackend[] = []
const indexedDbFactory = resolveIndexedDbFactory()
const browserLocalStorage = resolveLocalStorage()
if (indexedDbFactory) storageBackends.push(createIndexedDbStorageBackend(indexedDbFactory))
if (browserLocalStorage) storageBackends.push(createLocalStorageBackend(browserLocalStorage))
storageBackends.push(createMemoryStorageBackend())

export const storage = createFallbackStorageAdapter(storageBackends)

export const STORAGE_KEYS = {
  workoutDataV2: 'workout-data-v2',
  lastSession: 'last-completed-session',
  sessions: 'completed-sessions',
  plans: 'saved-plans',
} as const
