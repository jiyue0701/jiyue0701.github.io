import assert from 'node:assert/strict'
import test from 'node:test'
import { createFallbackStorageAdapter, createMemoryStorageBackend, STORAGE_KEYS } from '../src/lib/storage.ts'
import {
  COMPLETION_STORAGE_KEYS,
  completionEventIdForSession,
  createWorkoutCompletionRecord,
  isWorkoutCompletionRecord,
  readCompatibleCompletionHistory,
  upsertCompletionHistory,
  upsertStoredWorkoutCompletion,
  type CompatibleCompletedSession,
  type CompletionStorageAdapter,
} from '../src/workout/session.ts'
import {
  advanceWorkoutRuntime,
  createWorkoutRuntime,
  guidedWorkoutPlanV2,
  startWorkoutRuntime,
} from '../src/workout/runtime.ts'

function completedRuntime(sessionId: string) {
  const idle = createWorkoutRuntime(guidedWorkoutPlanV2, sessionId)
  const started = startWorkoutRuntime(idle, guidedWorkoutPlanV2, 0)
  return advanceWorkoutRuntime(started, guidedWorkoutPlanV2, guidedWorkoutPlanV2.plannedDurationMs).runtime
}

function completionRecord(sessionId: string, completedAt = '2026-07-29T12:00:00.000Z') {
  return createWorkoutCompletionRecord(completedRuntime(sessionId), guidedWorkoutPlanV2, {
    completedAt,
    estimatedCalories: 96,
  })
}

function appCompletionCallback(adapter: CompletionStorageAdapter, sessionId: string, completedAt = '2026-07-29T12:00:00.000Z') {
  const record = completionRecord(sessionId, completedAt)
  return upsertStoredWorkoutCompletion(adapter, record, STORAGE_KEYS)
}

function legacySession(completedAt: string): CompatibleCompletedSession {
  return {
    completedAt,
    rounds: 2,
    skipped: 0,
    estimatedCalories: 72,
    planTitle: '旧版训练',
    exerciseCount: 6,
  }
}

function createMemoryAdapter(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial))
  const adapter: CompletionStorageAdapter = {
    async get<T>(key: string) {
      await Promise.resolve()
      return (values.get(key) as T | undefined) ?? null
    },
    async set<T>(key: string, value: T) {
      await Promise.resolve()
      values.set(key, value)
    },
  }
  return { adapter, values }
}

test('completion identity is stable and derived from runtime sessionId', () => {
  const first = completionRecord('session-a')
  const repeated = completionRecord('session-a', '2026-07-29T12:01:00.000Z')
  const other = completionRecord('session-b')
  assert.equal(first.completionEventId, completionEventIdForSession('session-a'))
  assert.equal(first.completionEventId, repeated.completionEventId)
  assert.notEqual(first.completionEventId, other.completionEventId)
  assert.equal(first.planId, guidedWorkoutPlanV2.id)
  assert.equal(first.planVersion, guidedWorkoutPlanV2.version)
  assert.equal(first.plannedDurationMs, 856_500)
  assert.equal(isWorkoutCompletionRecord(first), true)
})

test('repeated completion for one session keeps one canonical record', () => {
  const first = completionRecord('same-session')
  const repeated = completionRecord('same-session', '2026-07-29T12:05:00.000Z')
  const inserted = upsertCompletionHistory([], first)
  const updated = upsertCompletionHistory(inserted.history, repeated)
  assert.equal(inserted.inserted, true)
  assert.equal(updated.inserted, false)
  assert.equal(updated.history.length, 1)
  assert.equal(updated.record.completedAt, first.completedAt)
  assert.equal(updated.record.completionEventId, first.completionEventId)
})

test('different session ids append normally', () => {
  const first = upsertCompletionHistory([], completionRecord('session-one'))
  const second = upsertCompletionHistory(first.history, completionRecord('session-two'))
  assert.equal(second.history.length, 2)
  assert.deepEqual(second.history.filter(isWorkoutCompletionRecord).map((item) => item.sessionId), ['session-one', 'session-two'])
})

test('legacy records remain readable and are never deduplicated by coincidental fields', () => {
  const duplicateLegacy = legacySession('2026-07-20T08:00:00.000Z')
  const legacyWithSessionId = {
    ...legacySession('2026-07-21T08:00:00.000Z'),
    sessionId: 'new-session',
  } as CompatibleCompletedSession
  const history = readCompatibleCompletionHistory([duplicateLegacy, { ...duplicateLegacy }, legacyWithSessionId, { bad: true }])
  const result = upsertCompletionHistory(history, completionRecord('new-session'))
  assert.equal(history.length, 3)
  assert.equal(result.history.length, 4)
  assert.equal(result.history.filter(isWorkoutCompletionRecord).length, 1)
})

test('App completion wiring imports legacy lastSession on the first v2 write', async () => {
  const legacy = legacySession('2026-07-18T08:00:00.000Z')
  const { adapter, values } = createMemoryAdapter({ [COMPLETION_STORAGE_KEYS.lastSession]: legacy })
  const result = await appCompletionCallback(adapter, 'first-v2')
  assert.equal(result.history.length, 2)
  assert.equal(result.history[0], legacy)
  assert.equal((values.get(COMPLETION_STORAGE_KEYS.sessions) as CompatibleCompletedSession[]).length, 2)
  assert.equal(isWorkoutCompletionRecord(values.get(COMPLETION_STORAGE_KEYS.lastSession)), true)
})

test('App completion wiring stores one record for repeated same-session callbacks', async () => {
  const { adapter, values } = createMemoryAdapter()
  const results = await Promise.all([
    appCompletionCallback(adapter, 'strict-mode-session'),
    appCompletionCallback(adapter, 'strict-mode-session', '2026-07-29T12:05:00.000Z'),
  ])
  const stored = values.get(COMPLETION_STORAGE_KEYS.sessions) as CompatibleCompletedSession[]
  assert.deepEqual(results.map((result) => result.inserted), [true, false])
  assert.equal(stored.length, 1)
  assert.equal(stored[0].completedAt, '2026-07-29T12:00:00.000Z')
})

test('App completion wiring retains different sessions', async () => {
  const { adapter, values } = createMemoryAdapter()
  await Promise.all([
    appCompletionCallback(adapter, 'concurrent-a'),
    appCompletionCallback(adapter, 'concurrent-b'),
  ])
  const stored = values.get(COMPLETION_STORAGE_KEYS.sessions) as CompatibleCompletedSession[]
  assert.deepEqual(stored.filter(isWorkoutCompletionRecord).map((item) => item.sessionId), ['concurrent-a', 'concurrent-b'])
})

test('App completion wiring can catch storage failure without duplicating optimistic UI history', async () => {
  const failingAdapter: CompletionStorageAdapter = {
    async get() { return null },
    async set() { throw new Error('storage unavailable') },
  }
  const record = completionRecord('storage-failure-session')
  const optimistic = upsertCompletionHistory([], record)
  await assert.rejects(upsertStoredWorkoutCompletion(failingAdapter, record, STORAGE_KEYS), /storage unavailable/)
  const repeated = upsertCompletionHistory(optimistic.history, record)
  assert.equal(repeated.history.length, 1)
  assert.equal(repeated.inserted, false)
})

test('App completion wiring treats memory-only fallback as non-persistent', async () => {
  const volatileAdapter = createFallbackStorageAdapter([createMemoryStorageBackend()])
  await assert.rejects(
    appCompletionCallback(volatileAdapter, 'memory-only-session'),
    /available only in memory/,
  )
  const retained = await volatileAdapter.get<CompatibleCompletedSession[]>(STORAGE_KEYS.sessions)
  assert.equal(retained?.length, 1)
  assert.equal(isWorkoutCompletionRecord(retained?.[0]), true)
})

test('App completion wiring rejects when the second write is memory-only', async () => {
  const values = new Map<string, unknown>()
  let writeCount = 0
  const partiallyPersistentAdapter: CompletionStorageAdapter = {
    async get<T>(key: string) { return (values.get(key) as T | undefined) ?? null },
    async set<T>(key: string, value: T) {
      values.set(key, value)
      writeCount += 1
      return { backend: writeCount === 1 ? 'localStorage' : 'memory', persisted: writeCount === 1 }
    },
  }
  await assert.rejects(
    appCompletionCallback(partiallyPersistentAdapter, 'second-write-memory-session'),
    /available only in memory/,
  )
  assert.equal((values.get(STORAGE_KEYS.sessions) as CompatibleCompletedSession[]).length, 1)
  assert.equal(isWorkoutCompletionRecord(values.get(STORAGE_KEYS.lastSession)), true)
})

test('a non-completed runtime cannot create a completion record', () => {
  const runtime = startWorkoutRuntime(createWorkoutRuntime(guidedWorkoutPlanV2, 'active-session'), guidedWorkoutPlanV2, 0)
  assert.throws(() => createWorkoutCompletionRecord(runtime, guidedWorkoutPlanV2, {
    completedAt: '2026-07-29T12:00:00.000Z',
    estimatedCalories: 96,
  }), /completed runtime/)
})
