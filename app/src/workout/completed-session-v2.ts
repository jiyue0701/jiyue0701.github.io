import type { CompletedSession } from '../types'
import {
  WORKOUT_DATA_V2_KEY,
  WorkoutP1Error,
  canonicalJson,
  canonicalizeLocalWorkoutStateV2,
  validateCompletedSessionV2,
  validateLocalWorkoutStateV2,
  type CompletedSessionV2,
  type LocalWorkoutStateV2,
} from './contracts-v2.ts'
import { buildWorkoutSegments, type WorkoutPlanV2, type WorkoutRuntimeV2 } from './runtime.ts'
import { persistWorkoutRootV2, withWorkoutRootWriteQueue, workoutRootNeedsPersistence } from './workout-data-v2.ts'

export type CompletionGenerationInputV2 = {
  runtime: WorkoutRuntimeV2
  plan: WorkoutPlanV2
  completedAt: string
  estimatedCalories: number
}

export type CompletedSessionV2UpsertResult = {
  state: LocalWorkoutStateV2
  record: CompletedSessionV2
  inserted: boolean
}

export type WorkoutRootStorageAdapter = {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<unknown>
}

function failSegment(message: string, path = '$'): never {
  throw new WorkoutP1Error('SESSION_SEGMENT_SET_INVALID', message, [{ code: 'SESSION_SEGMENT_SET_INVALID', severity: 'error', path, message }])
}

function isSafeMonotonicValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

function roundsCompleted(runtime: WorkoutRuntimeV2, plan: WorkoutPlanV2) {
  const segments = buildWorkoutSegments(plan)
  let completed = 0
  for (let roundIndex = 0; roundIndex < plan.rounds; roundIndex += 1) {
    const activeIds = segments.filter((segment) => segment.kind === 'active' && segment.roundIndex === roundIndex).map((segment) => segment.id)
    if (activeIds.length === plan.exercises.length && activeIds.every((id) => runtime.completedSegmentIds.includes(id)) && activeIds.every((id) => !runtime.skippedSegmentIds.includes(id))) completed += 1
  }
  return completed
}

export function createCompletedSessionV2(input: CompletionGenerationInputV2): CompletedSessionV2 {
  const { runtime, plan } = input
  if (runtime.state !== 'completed') throw new WorkoutP1Error('SESSION_NOT_COMPLETED', 'runtime must be completed')
  const sessionId = runtime.sessionId.trim()
  if (!sessionId || runtime.planId !== plan.id || runtime.planVersion !== plan.version || runtime.plannedDurationMs !== plan.plannedDurationMs) failSegment('runtime and plan identity do not match', '$.planId')
  const expectedCompletionId = `${sessionId}/workout/completed/1`
  if (runtime.completionEventId !== expectedCompletionId) failSegment('completion event ID is invalid', '$.completionEventId')
  const wallStartedAtMs = runtime.wallStartedAtMs
  const wallCompletedAtMs = runtime.wallCompletedAtMs
  if (!isSafeMonotonicValue(wallStartedAtMs) || !isSafeMonotonicValue(wallCompletedAtMs) || wallCompletedAtMs < wallStartedAtMs || !isSafeMonotonicValue(runtime.activeElapsedMs)) failSegment('runtime timing facts are invalid', '$.activeElapsedMs')
  const activeElapsedMs = Math.round(runtime.activeElapsedMs)
  const wallElapsedMs = Math.round(wallCompletedAtMs - wallStartedAtMs)
  if (!Number.isSafeInteger(activeElapsedMs) || !Number.isSafeInteger(wallElapsedMs) || activeElapsedMs > wallElapsedMs) failSegment('runtime timing invariants failed', '$.activeElapsedMs')

  const segmentIds = buildWorkoutSegments(plan).map((segment) => segment.id)
  const session: CompletedSessionV2 = {
    schemaVersion: 2,
    sessionId,
    planId: plan.id,
    planVersion: 2,
    completionEventId: expectedCompletionId,
    completedAt: input.completedAt,
    plannedDurationMs: runtime.plannedDurationMs,
    activeElapsedMs,
    wallElapsedMs,
    completedSegmentIds: [...runtime.completedSegmentIds],
    skippedSegmentIds: [...runtime.skippedSegmentIds],
    roundsCompleted: roundsCompleted(runtime, plan),
    summary: {
      planTitle: plan.title,
      exerciseCount: plan.exercises.length,
      estimatedCalories: input.estimatedCalories,
    },
  }
  const validation = validateCompletedSessionV2(session, segmentIds)
  if (!validation.ok) throw new WorkoutP1Error('SESSION_SEGMENT_SET_INVALID', 'completed session facts are invalid', validation.issues)
  if (session.roundsCompleted < 0 || session.roundsCompleted > plan.rounds) failSegment('round count is outside the plan', '$.roundsCompleted')
  return validation.value
}

export function upsertCompletedSessionV2(state: LocalWorkoutStateV2, record: CompletedSessionV2, maxEntries = 60): CompletedSessionV2UpsertResult {
  const rootValidation = validateLocalWorkoutStateV2(state)
  if (!rootValidation.ok) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'cannot update an invalid workout root', rootValidation.issues)
  const recordValidation = validateCompletedSessionV2(record)
  if (!recordValidation.ok) throw new WorkoutP1Error('SESSION_SEGMENT_SET_INVALID', 'cannot store an invalid completed session', recordValidation.issues)
  const canonicalState = rootValidation.value
  const existing = canonicalState.sessions.find((session) => session.sessionId === record.sessionId)
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(record)) throw new WorkoutP1Error('SESSION_CONFLICT', `session ${record.sessionId} already has different facts`)
    return { state: canonicalState, record: existing, inserted: false }
  }
  const limit = Math.max(1, Math.floor(maxEntries))
  const next = canonicalizeLocalWorkoutStateV2({
    ...canonicalState,
    sessions: [...canonicalState.sessions, record].slice(-limit),
    lastSessionRef: { kind: 'v2', sessionId: record.sessionId },
  })
  return { state: next, record, inserted: true }
}

export function upsertStoredCompletedSessionV2(
  adapter: WorkoutRootStorageAdapter,
  record: CompletedSessionV2,
  initialState: LocalWorkoutStateV2 | (() => Promise<LocalWorkoutStateV2>),
  maxEntries = 60,
): Promise<CompletedSessionV2UpsertResult> {
  return withWorkoutRootWriteQueue(adapter, async () => {
    const stored = await adapter.get<unknown>(WORKOUT_DATA_V2_KEY)
    const base = stored === null ? (typeof initialState === 'function' ? await initialState() : initialState) : stored
    const validation = validateLocalWorkoutStateV2(base)
    if (!validation.ok) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'invalid workout-data-v2 root; refusing legacy fallback overwrite', validation.issues)
    const upsert = upsertCompletedSessionV2(validation.value, record, maxEntries)
    if (!upsert.inserted && !workoutRootNeedsPersistence(adapter)) return upsert
    const verified = await persistWorkoutRootV2(adapter, upsert.state)
    return { ...upsert, state: verified }
  })
}

export function projectCompletedSessionV2(session: CompletedSessionV2): CompletedSession {
  return {
    completedAt: session.completedAt,
    rounds: session.roundsCompleted,
    skipped: session.skippedSegmentIds.length,
    estimatedCalories: session.summary.estimatedCalories,
    planTitle: session.summary.planTitle,
    exerciseCount: session.summary.exerciseCount,
  }
}
