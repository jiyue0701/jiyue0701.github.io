import {
  WORKOUT_DATA_V2_KEY,
  WorkoutP1Error,
  canonicalJson,
  canonicalizeLocalWorkoutStateV2,
  validateLocalWorkoutStateV2,
  type LocalWorkoutStateV2,
} from './contracts-v2.ts'
import { createFreshLocalWorkoutStateV2, migrateLegacyWorkoutDataV2, type LegacyWorkoutInputV1, type MigrationPreviewV2 } from './plan-migration-v2.ts'

export const LEGACY_WORKOUT_STORAGE_KEYS = {
  activePlan: 'active-plan',
  savedPlans: 'saved-plans',
  sessions: 'completed-sessions',
  lastSession: 'last-completed-session',
  selectedVoice: 'selected-voice',
} as const

export type WorkoutDataStorageAdapter = {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<unknown>
}

export type WorkoutDataLoadResultV2 = {
  state: LocalWorkoutStateV2
  source: 'v2' | 'fresh' | 'legacy-local'
  persisted: boolean
  preview?: MigrationPreviewV2
}

const workoutRootQueues = new WeakMap<WorkoutDataStorageAdapter, Promise<void>>()
const pendingDurability = new WeakSet<WorkoutDataStorageAdapter>()
const committedWorkoutRoots = new WeakMap<WorkoutDataStorageAdapter, LocalWorkoutStateV2>()

export function withWorkoutRootWriteQueue<T>(adapter: WorkoutDataStorageAdapter, operation: () => Promise<T>) {
  const previous = workoutRootQueues.get(adapter) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  workoutRootQueues.set(adapter, current.then(() => undefined, () => undefined))
  return current
}

function isPersisted(result: unknown) {
  return typeof result === 'object' && result !== null && 'persisted' in result && (result as { persisted: unknown }).persisted === true
}

export async function scanLegacyWorkoutStorageV1(adapter: WorkoutDataStorageAdapter): Promise<LegacyWorkoutInputV1> {
  const [activePlan, savedPlans, sessions, lastSession, selectedVoiceId] = await Promise.all([
    adapter.get<unknown>(LEGACY_WORKOUT_STORAGE_KEYS.activePlan),
    adapter.get<unknown[]>(LEGACY_WORKOUT_STORAGE_KEYS.savedPlans),
    adapter.get<unknown[]>(LEGACY_WORKOUT_STORAGE_KEYS.sessions),
    adapter.get<unknown>(LEGACY_WORKOUT_STORAGE_KEYS.lastSession),
    adapter.get<unknown>(LEGACY_WORKOUT_STORAGE_KEYS.selectedVoice),
  ])
  return { activePlan, savedPlans, sessions, lastSession, selectedVoiceId }
}

export async function persistWorkoutRootV2(adapter: WorkoutDataStorageAdapter, candidate: LocalWorkoutStateV2) {
  const validation = validateLocalWorkoutStateV2(candidate)
  if (!validation.ok) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'workout root failed staging validation', validation.issues)
  const staged = canonicalizeLocalWorkoutStateV2(validation.value)
  let write: unknown
  try {
    write = await adapter.set(WORKOUT_DATA_V2_KEY, staged)
  } catch (error) {
    pendingDurability.add(adapter)
    throw error
  }
  if (!isPersisted(write)) {
    pendingDurability.add(adapter)
    throw new WorkoutP1Error('BACKUP_PERSIST_FAILED', 'no persistent backend accepted workout-data-v2')
  }
  const reread = await adapter.get<unknown>(WORKOUT_DATA_V2_KEY)
  const verified = validateLocalWorkoutStateV2(reread)
  if (!verified.ok || canonicalJson(verified.value) !== canonicalJson(staged)) {
    pendingDurability.add(adapter)
    throw new WorkoutP1Error('BACKUP_PERSIST_FAILED', 'workout-data-v2 reread verification failed')
  }
  pendingDurability.delete(adapter)
  committedWorkoutRoots.set(adapter, verified.value)
  return verified.value
}

export function workoutRootNeedsPersistence(adapter: WorkoutDataStorageAdapter) {
  return pendingDurability.has(adapter)
}

export async function loadOrMigrateWorkoutDataV2(
  adapter: WorkoutDataStorageAdapter,
  options: { completedAt: string; knownVoiceIds: readonly string[] },
): Promise<WorkoutDataLoadResultV2> {
  const existing = await adapter.get<unknown>(WORKOUT_DATA_V2_KEY)
  if (existing !== null) {
    const validation = validateLocalWorkoutStateV2(existing)
    if (!validation.ok) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'invalid workout-data-v2 root; legacy fallback is forbidden', validation.issues)
    if (pendingDurability.has(adapter)) {
      const state = await withWorkoutRootWriteQueue(adapter, () => persistWorkoutRootV2(adapter, committedWorkoutRoots.get(adapter) ?? validation.value))
      return { state, source: 'v2', persisted: true }
    }
    committedWorkoutRoots.set(adapter, validation.value)
    return { state: validation.value, source: 'v2', persisted: true }
  }
  const legacy = await scanLegacyWorkoutStorageV1(adapter)
  const hasLegacy = Object.values(legacy).some((value) => value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0))
  const preview = hasLegacy
    ? migrateLegacyWorkoutDataV2(legacy, { source: 'legacy-local', migratedAt: options.completedAt, knownVoiceIds: options.knownVoiceIds })
    : undefined
  const candidate = preview?.state ?? createFreshLocalWorkoutStateV2(options.completedAt)
  const state = await withWorkoutRootWriteQueue(adapter, () => persistWorkoutRootV2(adapter, candidate))
  return { state, source: preview ? 'legacy-local' : 'fresh', persisted: true, ...(preview ? { preview } : {}) }
}

export async function replaceWorkoutRootV2(adapter: WorkoutDataStorageAdapter, candidate: LocalWorkoutStateV2) {
  return withWorkoutRootWriteQueue(adapter, () => persistWorkoutRootV2(adapter, candidate))
}

export async function updateWorkoutRootV2(adapter: WorkoutDataStorageAdapter, update: (current: LocalWorkoutStateV2) => LocalWorkoutStateV2) {
  return withWorkoutRootWriteQueue(adapter, async () => {
    const current = await readWorkoutRootV2(adapter)
    if (!current) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'workout-data-v2 root is missing')
    return persistWorkoutRootV2(adapter, update(current))
  })
}

export async function readWorkoutRootV2(adapter: WorkoutDataStorageAdapter) {
  if (pendingDurability.has(adapter)) {
    const committed = committedWorkoutRoots.get(adapter)
    if (committed) return committed
  }
  const value = await adapter.get<unknown>(WORKOUT_DATA_V2_KEY)
  if (value === null) return null
  const validation = validateLocalWorkoutStateV2(value)
  if (!validation.ok) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'invalid workout-data-v2 root', validation.issues)
  committedWorkoutRoots.set(adapter, validation.value)
  return validation.value
}
