import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFallbackStorageAdapter,
  createLocalStorageBackend,
  createMemoryStorageBackend,
  type StorageBackend,
} from '../src/lib/storage.ts'

function createFakeBackend(
  name: string,
  persistent: boolean,
  values = new Map<string, unknown>(),
  failures: { get?: boolean; set?: boolean | ((value: unknown) => boolean) } = {},
) {
  const backend: StorageBackend = {
    name,
    persistent,
    async get(key) {
      if (failures.get) throw new Error(`${name} get failed`)
      return values.has(key) ? values.get(key) ?? null : null
    },
    async set(key, value) {
      const shouldFail = typeof failures.set === 'function' ? failures.set(value) : failures.set
      if (shouldFail) throw new Error(`${name} set failed`)
      values.set(key, value)
    },
  }
  return { backend, values }
}

function createFakeLocalStorage() {
  const values = new Map<string, string>()
  return {
    values,
    storage: {
      getItem(key: string) { return values.get(key) ?? null },
      setItem(key: string, value: string) { values.set(key, value) },
    },
  }
}

test('read continues from failed IndexedDB to localStorage', async () => {
  const indexed = createFakeBackend('indexedDB', true, new Map(), { get: true })
  const local = createFakeBackend('localStorage', true, new Map([['sessions', { legacy: true }]]))
  const adapter = createFallbackStorageAdapter([indexed.backend, local.backend, createMemoryStorageBackend()])
  assert.deepEqual(await adapter.get('sessions'), { legacy: true })
})

test('write falls back to localStorage and reports durable success', async () => {
  const indexed = createFakeBackend('indexedDB', true, new Map(), { set: true })
  const local = createFakeBackend('localStorage', true)
  const adapter = createFallbackStorageAdapter([indexed.backend, local.backend, createMemoryStorageBackend()])
  const result = await adapter.set('sessions', [{ id: 1 }])
  assert.equal(result.persisted, true)
  assert.equal(result.backend, 'localStorage')
  assert.deepEqual(result.failedBackends, ['indexedDB'])
  assert.deepEqual(await adapter.get('sessions'), [{ id: 1 }])
})

test('memory-only fallback is explicit and never presented as persisted', async () => {
  const indexed = createFakeBackend('indexedDB', true, new Map(), { set: true })
  const local = createFakeBackend('localStorage', true, new Map(), { set: true })
  const adapter = createFallbackStorageAdapter([indexed.backend, local.backend, createMemoryStorageBackend()])
  const result = await adapter.set('sessions', [{ id: 2 }])
  assert.equal(result.persisted, false)
  assert.equal(result.backend, 'memory')
  assert.deepEqual(result.failedBackends, ['indexedDB', 'localStorage'])
  assert.deepEqual(await adapter.get('sessions'), [{ id: 2 }])
})

test('new envelope wins over legacy raw revision zero and stale IndexedDB data', async () => {
  const indexed = createFakeBackend('indexedDB', true, new Map([['plan', { stale: true }]]), { set: true })
  const local = createFakeBackend('localStorage', true)
  const adapter = createFallbackStorageAdapter([indexed.backend, local.backend, createMemoryStorageBackend()])
  assert.deepEqual(await adapter.get('plan'), { stale: true })
  await adapter.set('plan', { current: true })
  assert.deepEqual(await adapter.get('plan'), { current: true })
})

test('delete tombstone prevents stale data from a failed backend resurfacing', async () => {
  const indexed = createFakeBackend('indexedDB', true, new Map([['plan', { stale: true }]]), { set: true })
  const local = createFakeBackend('localStorage', true, new Map([['plan', { stale: true }]]))
  const adapter = createFallbackStorageAdapter([indexed.backend, local.backend, createMemoryStorageBackend()])
  const result = await adapter.remove('plan')
  assert.equal(result.persisted, true)
  assert.deepEqual(result.failedBackends, ['indexedDB'])
  assert.equal(await adapter.get('plan'), null)
})

test('localStorage fallback survives a new adapter instance', async () => {
  const local = createFakeLocalStorage()
  const failedIndexed = createFakeBackend('indexedDB', true, new Map(), { get: true, set: true })
  const first = createFallbackStorageAdapter([failedIndexed.backend, createLocalStorageBackend(local.storage), createMemoryStorageBackend()])
  const result = await first.set('sessions', [{ sessionId: 'persisted' }])
  assert.equal(result.persisted, true)

  const refreshed = createFallbackStorageAdapter([failedIndexed.backend, createLocalStorageBackend(local.storage), createMemoryStorageBackend()])
  assert.deepEqual(await refreshed.get('sessions'), [{ sessionId: 'persisted' }])
})

test('invalid localStorage JSON falls through to memory', async () => {
  const brokenLocal = {
    getItem() { return '{not-json' },
    setItem() {},
  }
  const memoryValues = new Map<string, unknown>([['sessions', [{ sessionId: 'memory-copy' }]]])
  const adapter = createFallbackStorageAdapter([
    createLocalStorageBackend(brokenLocal),
    createMemoryStorageBackend(memoryValues),
  ])
  assert.deepEqual(await adapter.get('sessions'), [{ sessionId: 'memory-copy' }])
})

test('an adapter with no successful backend rejects instead of swallowing the write', async () => {
  const first = createFakeBackend('indexedDB', true, new Map(), { set: true })
  const second = createFakeBackend('localStorage', true, new Map(), { set: true })
  const third = createFakeBackend('memory', false, new Map(), { set: true })
  const adapter = createFallbackStorageAdapter([first.backend, second.backend, third.backend])
  await assert.rejects(adapter.set('sessions', []), /storage write failed/)
})
