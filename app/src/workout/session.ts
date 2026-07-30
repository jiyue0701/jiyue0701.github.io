import type { CompletedSession } from '../types'
import type { WorkoutPlanV2, WorkoutRuntimeV2 } from './runtime'

export const COMPLETION_STORAGE_KEYS = {
  lastSession: 'last-completed-session',
  sessions: 'completed-sessions',
} as const

export type WorkoutCompletionRecord = CompletedSession & {
  sessionId: string
  planId: string
  planVersion: number
  plannedDurationMs: number
  completionEventId: string
}

export type CompatibleCompletedSession = CompletedSession | WorkoutCompletionRecord

export type CompletionRecordOptions = {
  completedAt: string
  estimatedCalories: number
}

export type CompletionUpsertResult = {
  history: CompatibleCompletedSession[]
  record: WorkoutCompletionRecord
  inserted: boolean
}

export type CompletionStorageAdapter = {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<unknown>
}

export type CompletionStorageKeys = {
  lastSession: string
  sessions: string
}

const completionWriteQueues = new WeakMap<CompletionStorageAdapter, Promise<void>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function completionEventIdForSession(sessionId: string) {
  const normalized = sessionId.trim()
  if (!normalized) throw new Error('sessionId is required for workout completion')
  return `${normalized}/workout/completed/1`
}

export function isCompatibleCompletedSession(value: unknown): value is CompatibleCompletedSession {
  if (!isRecord(value)) return false
  return typeof value.completedAt === 'string'
    && value.completedAt.length > 0
    && isFiniteNumber(value.rounds)
    && isFiniteNumber(value.skipped)
    && isFiniteNumber(value.estimatedCalories)
}

export function isWorkoutCompletionRecord(value: unknown): value is WorkoutCompletionRecord {
  if (!isRecord(value) || !isCompatibleCompletedSession(value)) return false
  if (!('sessionId' in value) || typeof value.sessionId !== 'string' || !value.sessionId.trim()) return false
  return 'planId' in value
    && typeof value.planId === 'string'
    && value.planId.length > 0
    && 'planVersion' in value
    && isFiniteNumber(value.planVersion)
    && value.planVersion > 0
    && 'plannedDurationMs' in value
    && isFiniteNumber(value.plannedDurationMs)
    && value.plannedDurationMs >= 0
    && 'completionEventId' in value
    && value.completionEventId === completionEventIdForSession(value.sessionId)
}

export function readCompatibleCompletionHistory(value: unknown): CompatibleCompletedSession[] {
  if (!Array.isArray(value)) return []
  return value.filter(isCompatibleCompletedSession)
}

export function createWorkoutCompletionRecord(
  runtime: WorkoutRuntimeV2,
  plan: WorkoutPlanV2,
  options: CompletionRecordOptions,
): WorkoutCompletionRecord {
  if (runtime.state !== 'completed') throw new Error('workout completion requires a completed runtime')
  if (!options.completedAt.trim()) throw new Error('completedAt is required for workout completion')
  if (!Number.isFinite(options.estimatedCalories) || options.estimatedCalories < 0) throw new Error('estimatedCalories must be a non-negative number')
  const sessionId = runtime.sessionId.trim()
  return {
    sessionId,
    planId: plan.id,
    planVersion: plan.version,
    plannedDurationMs: plan.plannedDurationMs,
    completionEventId: completionEventIdForSession(sessionId),
    completedAt: options.completedAt,
    rounds: plan.rounds,
    skipped: new Set(runtime.skippedExerciseIds).size,
    estimatedCalories: options.estimatedCalories,
    planTitle: plan.title,
    exerciseCount: plan.exercises.length,
  }
}

export function upsertCompletionHistory(
  history: readonly CompatibleCompletedSession[],
  record: WorkoutCompletionRecord,
  maxEntries = 60,
): CompletionUpsertResult {
  if (!isWorkoutCompletionRecord(record)) throw new Error('invalid workout completion record')
  const safeHistory = history.filter(isCompatibleCompletedSession)
  const existingIndex = safeHistory.findIndex((entry) => isWorkoutCompletionRecord(entry) && entry.sessionId === record.sessionId)
  if (existingIndex >= 0) {
    const existing = safeHistory[existingIndex] as WorkoutCompletionRecord
    const canonical: WorkoutCompletionRecord = {
      ...existing,
      ...record,
      completedAt: existing.completedAt,
      completionEventId: existing.completionEventId,
    }
    const next = [...safeHistory]
    next[existingIndex] = canonical
    return { history: next, record: canonical, inserted: false }
  }

  const limit = Math.max(1, Math.floor(maxEntries))
  const next = [...safeHistory, record].slice(-limit)
  return { history: next, record, inserted: true }
}

function enqueueCompletionWrite<T>(adapter: CompletionStorageAdapter, operation: () => Promise<T>) {
  const previous = completionWriteQueues.get(adapter) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  completionWriteQueues.set(adapter, current.then(() => undefined, () => undefined))
  return current
}

function requirePersistentWrite(result: unknown) {
  if (typeof result !== 'object' || result === null || !('persisted' in result)) return
  if ((result as { persisted?: unknown }).persisted === false) throw new Error('completion record is available only in memory')
}

export function upsertStoredWorkoutCompletion(
  adapter: CompletionStorageAdapter,
  record: WorkoutCompletionRecord,
  keys: CompletionStorageKeys = COMPLETION_STORAGE_KEYS,
  maxEntries = 60,
): Promise<CompletionUpsertResult> {
  return enqueueCompletionWrite(adapter, async () => {
    const storedHistory = readCompatibleCompletionHistory(await adapter.get<unknown>(keys.sessions))
    let history = storedHistory
    if (!history.length) {
      const storedLastSession = await adapter.get<unknown>(keys.lastSession)
      if (isCompatibleCompletedSession(storedLastSession)) history = [storedLastSession]
    }
    const result = upsertCompletionHistory(history, record, maxEntries)
    requirePersistentWrite(await adapter.set(keys.sessions, result.history))
    requirePersistentWrite(await adapter.set(keys.lastSession, result.record))
    return result
  })
}
