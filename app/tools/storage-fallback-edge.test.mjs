import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFallbackStorageAdapter,
  createLocalStorageBackend,
  createMemoryStorageBackend,
  STORAGE_KEYS,
} from '../src/lib/storage.ts'
import {
  createWorkoutCompletionRecord,
  upsertStoredWorkoutCompletion,
} from '../src/workout/session.ts'
import {
  advanceWorkoutRuntime,
  createWorkoutRuntime,
  guidedWorkoutPlanV2,
  startWorkoutRuntime,
} from '../src/workout/runtime.ts'

function fakeBackend(name, persistent, initial = [], controls = {}) {
  const values = new Map(initial)
  return {
    values,
    backend: {
      name,
      persistent,
      async get(key) {
        if (controls.failGet?.()) throw new Error(`${name} get failed`)
        return values.has(key) ? values.get(key) ?? null : null
      },
      async set(key, value) {
        if (controls.failSet?.(value)) throw new Error(`${name} set failed`)
        values.set(key, value)
      },
    },
  }
}

function envelope(revision, value, deleted = false) {
  return { __workoutStorage: 1, revision, deleted, ...(deleted ? {} : { value }) }
}

function completionRecord(sessionId) {
  const idle = createWorkoutRuntime(guidedWorkoutPlanV2, sessionId)
  const active = startWorkoutRuntime(idle, guidedWorkoutPlanV2, 0)
  const runtime = advanceWorkoutRuntime(active, guidedWorkoutPlanV2, guidedWorkoutPlanV2.plannedDurationMs).runtime
  return createWorkoutCompletionRecord(runtime, guidedWorkoutPlanV2, {
    completedAt: '2026-07-29T12:00:00.000Z',
    estimatedCalories: 96,
  })
}

test('QA-STORAGE-EDGE-001 all IndexedDB/localStorage/memory write failure combinations are explicit', async () => {
  const names = ['indexedDB', 'localStorage', 'memory']
  for (let mask = 0; mask < 8; mask += 1) {
    const stores = names.map((name, index) => fakeBackend(name, index < 2, [], {
      failSet: () => Boolean(mask & (1 << index)),
    }))
    const adapter = createFallbackStorageAdapter(stores.map((item) => item.backend))
    const failed = names.filter((_, index) => Boolean(mask & (1 << index)))
    if (mask === 7) {
      await assert.rejects(adapter.set('matrix', { mask }), /storage write failed/, `mask ${mask}`)
      continue
    }
    const result = await adapter.set('matrix', { mask })
    const successfulPersistent = names.find((_, index) => index < 2 && !(mask & (1 << index)))
    const expectedBackend = successfulPersistent ?? 'memory'
    assert.equal(result.backend, expectedBackend, `mask ${mask}`)
    assert.equal(result.persisted, expectedBackend !== 'memory', `mask ${mask}`)
    assert.deepEqual(result.failedBackends, failed, `mask ${mask}`)
    assert.equal(result.fallbackUsed, failed.length > 0 || expectedBackend !== 'indexedDB', `mask ${mask}`)
    assert.deepEqual(await adapter.get('matrix'), { mask }, `mask ${mask}`)
  }
})

test('QA-STORAGE-EDGE-002 read failures choose the highest valid revision and all-failed reads return null', async () => {
  for (let mask = 0; mask < 8; mask += 1) {
    const stores = [
      fakeBackend('indexedDB', true, [['key', envelope(1, 'indexed')]], { failGet: () => Boolean(mask & 1) }),
      fakeBackend('localStorage', true, [['key', envelope(2, 'local')]], { failGet: () => Boolean(mask & 2) }),
      fakeBackend('memory', false, [['key', envelope(3, 'memory')]], { failGet: () => Boolean(mask & 4) }),
    ]
    const adapter = createFallbackStorageAdapter(stores.map((item) => item.backend))
    const expected = !(mask & 4) ? 'memory' : !(mask & 2) ? 'local' : !(mask & 1) ? 'indexed' : null
    assert.equal(await adapter.get('key'), expected, `mask ${mask}`)
  }
})

test('QA-STORAGE-EDGE-003 envelopes beat legacy raw values and a newer tombstone prevents resurrection', async () => {
  const indexed = fakeBackend('indexedDB', true, [['key', { legacy: true }]])
  const local = fakeBackend('localStorage', true, [['key', envelope(10, { current: true })]])
  const memory = fakeBackend('memory', false, [['key', envelope(11, undefined, true)]])
  const adapter = createFallbackStorageAdapter([indexed.backend, local.backend, memory.backend])
  assert.equal(await adapter.get('key'), null)
})

test('QA-STORAGE-EDGE-004 equal-revision tombstones win ties to fail closed', async () => {
  const indexed = fakeBackend('indexedDB', true, [['key', envelope(10, { stale: true })]])
  const local = fakeBackend('localStorage', true, [['key', envelope(10, undefined, true)]])
  const adapter = createFallbackStorageAdapter([indexed.backend, local.backend, createMemoryStorageBackend()])
  assert.equal(await adapter.get('key'), null)
})

test('QA-STORAGE-EDGE-005 invalid envelope revisions cannot outrank valid persisted data', async () => {
  for (const corruptRevision of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const indexed = fakeBackend('indexedDB', true, [['key', envelope(corruptRevision, { corrupt: true })]])
    const local = fakeBackend('localStorage', true, [['key', envelope(10, { valid: true })]])
    const adapter = createFallbackStorageAdapter([indexed.backend, local.backend, createMemoryStorageBackend()])
    assert.deepEqual(await adapter.get('key'), { valid: true })
  }
})

test('QA-STORAGE-EDGE-006 a same-millisecond write from a fresh adapter is not hidden by a stale replica', async () => {
  const controls = { indexedFails: false }
  const indexed = fakeBackend('indexedDB', true, [], { failSet: () => controls.indexedFails })
  const local = fakeBackend('localStorage', true)
  const memory = fakeBackend('memory', false)
  const backends = [indexed.backend, local.backend, memory.backend]
  const originalNow = Date.now
  Date.now = () => 1_800_000_000_000
  try {
    const firstAdapter = createFallbackStorageAdapter(backends)
    await firstAdapter.set('key', { value: 'first' })
    await firstAdapter.set('key', { value: 'second' })
    controls.indexedFails = true
    const refreshedAdapter = createFallbackStorageAdapter(backends)
    const write = await refreshedAdapter.set('key', { value: 'fresh-after-reload' })
    assert.equal(write.persisted, true)
    assert.deepEqual(await refreshedAdapter.get('key'), { value: 'fresh-after-reload' })
  } finally {
    Date.now = originalNow
  }
})

test('QA-STORAGE-EDGE-007 corrupt localStorage JSON falls through and memory-only writes remain explicit', async () => {
  const brokenLocal = createLocalStorageBackend({
    getItem() { return '{broken-json' },
    setItem() { throw new Error('localStorage quota') },
  })
  const memoryValues = new Map([['key', envelope(4, { memory: true })]])
  const adapter = createFallbackStorageAdapter([brokenLocal, createMemoryStorageBackend(memoryValues)])
  assert.deepEqual(await adapter.get('key'), { memory: true })
  const result = await adapter.set('key', { memory: 'updated' })
  assert.equal(result.persisted, false)
  assert.equal(result.backend, 'memory')
  assert.deepEqual(result.failedBackends, ['localStorage'])
  assert.deepEqual(await adapter.get('key'), { memory: 'updated' })
})

test('QA-STORAGE-EDGE-008 either non-persistent completion write rejects while retaining written memory state', async () => {
  for (const volatileWrite of [1, 2]) {
    const values = new Map()
    let writeCount = 0
    const adapter = {
      async get(key) { return values.get(key) ?? null },
      async set(key, value) {
        values.set(key, value)
        writeCount += 1
        return { backend: writeCount === volatileWrite ? 'memory' : 'localStorage', persisted: writeCount !== volatileWrite }
      },
    }
    await assert.rejects(
      upsertStoredWorkoutCompletion(adapter, completionRecord(`volatile-write-${volatileWrite}`), STORAGE_KEYS),
      /available only in memory/,
    )
    assert.equal(Array.isArray(values.get(STORAGE_KEYS.sessions)), true, `write ${volatileWrite}`)
    assert.equal(values.get(STORAGE_KEYS.sessions).length, 1, `write ${volatileWrite}`)
    assert.equal(values.has(STORAGE_KEYS.lastSession), volatileWrite === 2, `write ${volatileWrite}`)
  }
})
