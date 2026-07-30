import type { Exercise, TrainingPlan } from '../types.ts'
import type { LocalWorkoutStateV2 } from './contracts-v2.ts'
import { refreshWorkoutPlanStateV2 } from './plan-migration-v2.ts'
import {
  LEGACY_WORKOUT_STORAGE_KEYS,
  persistWorkoutRootV2,
  readWorkoutRootV2,
  withWorkoutRootWriteQueue,
  type WorkoutDataStorageAdapter,
} from './workout-data-v2.ts'

export const WORKOUT_APP_RETRY_NOTICE = '本机保存失败，请重试。'
export const WORKOUT_APP_LEGACY_WARNING_NOTICE = '主数据已保存，但兼容副本暂未同步；刷新后仍以主数据为准。'

export type WorkoutPlanUiSnapshotV2 = {
  activePlan: TrainingPlan
  savedPlans: TrainingPlan[]
  selectedVoiceId: string | null
}

export type WorkoutPlanUiContextV2 = {
  defaultPlan: TrainingPlan
  exerciseCatalog: readonly Exercise[]
}

export type WorkoutAppMutationCommandV2 =
  | { type: 'save_plan'; plan: TrainingPlan }
  | { type: 'apply_plan'; planId: string }
  | { type: 'rename_plan'; planId: string; title: string }
  | { type: 'delete_plan'; planId: string }
  | { type: 'select_voice'; voiceId: string }

type LegacyWriteV2 = { key: string; value: unknown }

export type WorkoutAppMutationCommitV2 = {
  state: LocalWorkoutStateV2
  snapshot: WorkoutPlanUiSnapshotV2
  command: WorkoutAppMutationCommandV2
  legacyPersisted: boolean
}

export type WorkoutAppMutationExecutionV2 =
  | { ok: true; commit: WorkoutAppMutationCommitV2 }
  | { ok: false; error: unknown }

export function isStoredTrainingPlanV2(value: unknown): value is TrainingPlan {
  return typeof value === 'object' && value !== null
    && typeof (value as TrainingPlan).id === 'string'
    && ((value as TrainingPlan).source === 'preset' || (value as TrainingPlan).source === 'personal')
    && Array.isArray((value as TrainingPlan).exercises)
}

export function hydrateStoredPlanV2(storedPlan: TrainingPlan, context: WorkoutPlanUiContextV2): TrainingPlan {
  if (storedPlan.id === 'lower-body-foundation-v0-2') return context.defaultPlan
  const latestExercises = new Map(context.exerciseCatalog.map((exercise) => [exercise.id, exercise]))
  return {
    ...storedPlan,
    exercises: storedPlan.exercises.map((exercise) => latestExercises.get(exercise.id) ?? exercise),
  }
}

function legacyPlanForRecord(state: LocalWorkoutStateV2, planId: string, context: WorkoutPlanUiContextV2) {
  const record = state.plans.find((plan) => plan.id === planId)
  const data = state.legacyPlans.find((entry) => entry.sourceFingerprintSha256 === record?.migration?.sourceFingerprintSha256)?.data
  return isStoredTrainingPlanV2(data) ? hydrateStoredPlanV2(data, context) : null
}

export function projectWorkoutPlanStateForUiV2(state: LocalWorkoutStateV2, context: WorkoutPlanUiContextV2): WorkoutPlanUiSnapshotV2 {
  const savedPlans = state.plans
    .filter((plan) => plan.source === 'personal')
    .map((plan) => legacyPlanForRecord(state, plan.id, context))
    .filter((plan): plan is TrainingPlan => plan !== null)
  const activePlan = state.editorSelectedPlanId === state.fixedRuntimePlanId
    ? context.defaultPlan
    : legacyPlanForRecord(state, state.editorSelectedPlanId ?? '', context) ?? context.defaultPlan
  return { activePlan: hydrateStoredPlanV2(activePlan, context), savedPlans, selectedVoiceId: state.selectedVoiceId }
}

function renamePlan(plan: TrainingPlan, title: string): TrainingPlan {
  return { ...plan, title, subtitle: plan.subtitle.replace(plan.title, title) }
}

function stageWorkoutAppMutationV2(
  current: LocalWorkoutStateV2,
  command: WorkoutAppMutationCommandV2,
  options: { migratedAt: string; knownVoiceIds: readonly string[]; planUiContext: WorkoutPlanUiContextV2 },
) {
  const snapshot = projectWorkoutPlanStateForUiV2(current, options.planUiContext)
  let activePlan = snapshot.activePlan
  let savedPlans = snapshot.savedPlans
  let selectedVoiceId = snapshot.selectedVoiceId
  let legacyWrites: LegacyWriteV2[]

  switch (command.type) {
    case 'save_plan': {
      const plan = hydrateStoredPlanV2(command.plan, options.planUiContext)
      savedPlans = [...savedPlans.filter((item) => item.id !== plan.id), plan]
      activePlan = plan
      legacyWrites = [
        { key: LEGACY_WORKOUT_STORAGE_KEYS.savedPlans, value: savedPlans },
        { key: LEGACY_WORKOUT_STORAGE_KEYS.activePlan, value: activePlan },
      ]
      break
    }
    case 'apply_plan': {
      const plan = savedPlans.find((item) => item.id === command.planId)
      if (!plan) throw new Error(`personal plan ${command.planId} is no longer available`)
      activePlan = plan
      legacyWrites = [{ key: LEGACY_WORKOUT_STORAGE_KEYS.activePlan, value: activePlan }]
      break
    }
    case 'rename_plan': {
      const plan = savedPlans.find((item) => item.id === command.planId)
      if (!plan) throw new Error(`personal plan ${command.planId} is no longer available`)
      savedPlans = savedPlans.map((item) => item.id === command.planId ? renamePlan(item, command.title) : item)
      if (activePlan.id === command.planId) activePlan = renamePlan(activePlan, command.title)
      legacyWrites = [
        { key: LEGACY_WORKOUT_STORAGE_KEYS.savedPlans, value: savedPlans },
        { key: LEGACY_WORKOUT_STORAGE_KEYS.activePlan, value: activePlan },
      ]
      break
    }
    case 'delete_plan': {
      if (!savedPlans.some((item) => item.id === command.planId)) throw new Error(`personal plan ${command.planId} is no longer available`)
      savedPlans = savedPlans.filter((item) => item.id !== command.planId)
      if (activePlan.id === command.planId) activePlan = options.planUiContext.defaultPlan
      legacyWrites = [
        { key: LEGACY_WORKOUT_STORAGE_KEYS.savedPlans, value: savedPlans },
        { key: LEGACY_WORKOUT_STORAGE_KEYS.activePlan, value: activePlan },
      ]
      break
    }
    case 'select_voice':
      selectedVoiceId = command.voiceId
      legacyWrites = [{ key: LEGACY_WORKOUT_STORAGE_KEYS.selectedVoice, value: selectedVoiceId }]
      break
  }

  const state = refreshWorkoutPlanStateV2(
    current,
    { activePlan, savedPlans, selectedVoiceId },
    { migratedAt: options.migratedAt, knownVoiceIds: options.knownVoiceIds },
  ).state
  return { state, snapshot: projectWorkoutPlanStateForUiV2(state, options.planUiContext), legacyWrites }
}

function mutationPersisted(result: unknown) {
  return typeof result === 'object' && result !== null && 'persisted' in result && (result as { persisted: unknown }).persisted === true
}

async function persistLegacyWrites(adapter: WorkoutDataStorageAdapter, writes: LegacyWriteV2[]) {
  let persisted = true
  for (const write of writes) {
    try {
      persisted = mutationPersisted(await adapter.set(write.key, write.value)) && persisted
    } catch {
      persisted = false
    }
  }
  return persisted
}

export async function executeWorkoutAppMutationV2(input: {
  adapter: WorkoutDataStorageAdapter
  command: WorkoutAppMutationCommandV2
  migratedAt: string
  knownVoiceIds: readonly string[]
  planUiContext: WorkoutPlanUiContextV2
  successNotice: string
  setNotice: (notice: string) => void
  onCommitted: (commit: WorkoutAppMutationCommitV2) => void
  onError?: (error: unknown) => void
}): Promise<WorkoutAppMutationExecutionV2> {
  try {
    return await withWorkoutRootWriteQueue(input.adapter, async () => {
      const current = await readWorkoutRootV2(input.adapter)
      if (!current) throw new Error('workout-data-v2 root is missing')
      const staged = stageWorkoutAppMutationV2(current, input.command, {
        migratedAt: input.migratedAt,
        knownVoiceIds: input.knownVoiceIds,
        planUiContext: input.planUiContext,
      })
      const state = await persistWorkoutRootV2(input.adapter, staged.state)
      const legacyPersisted = await persistLegacyWrites(input.adapter, staged.legacyWrites)
      const commit = { state, snapshot: staged.snapshot, command: input.command, legacyPersisted }
      input.onCommitted(commit)
      input.setNotice(legacyPersisted ? input.successNotice : WORKOUT_APP_LEGACY_WARNING_NOTICE)
      return { ok: true, commit }
    })
  } catch (error) {
    input.onError?.(error)
    input.setNotice(WORKOUT_APP_RETRY_NOTICE)
    return { ok: false, error }
  }
}
