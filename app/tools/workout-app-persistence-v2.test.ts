import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  WORKOUT_APP_RETRY_NOTICE,
  WORKOUT_APP_LEGACY_WARNING_NOTICE,
  executeWorkoutAppMutationV2,
  projectWorkoutPlanStateForUiV2,
  type WorkoutAppMutationCommandV2,
  type WorkoutPlanUiSnapshotV2,
} from '../src/workout/app-persistence-v2.ts'
import { WORKOUT_DATA_V2_KEY, canonicalJson, type LocalWorkoutStateV2 } from '../src/workout/contracts-v2.ts'
import { createFreshLocalWorkoutStateV2, migrateLegacyWorkoutDataV2 } from '../src/workout/plan-migration-v2.ts'
import { LEGACY_WORKOUT_STORAGE_KEYS, loadOrMigrateWorkoutDataV2 } from '../src/workout/workout-data-v2.ts'
import type { TrainingPlan } from '../src/types.ts'

const ISO = '2026-07-30T08:00:00.000Z'
const ISO_2 = '2026-07-30T08:01:00.000Z'
const KNOWN_VOICES = ['low', 'clear']
const DEFAULT_PLAN: TrainingPlan = {
  id: 'lower-body-foundation-v0-2',
  title: 'default',
  subtitle: 'default',
  duration: 15,
  rounds: 3,
  estimatedCalories: 96,
  source: 'preset',
  exercises: [],
}
const PLAN_UI_CONTEXT = { defaultPlan: DEFAULT_PLAN, exerciseCatalog: [] }

function personalPlan(id: string, exerciseId = 'bodyweight-squat'): TrainingPlan {
  return {
    id,
    title: `fixture-${id}`,
    subtitle: `fixture-${id} · 2 轮`,
    duration: 5,
    rounds: 2,
    estimatedCalories: 42,
    source: 'personal',
    exercises: [{
      id: exerciseId,
      name: `fixture-${exerciseId}`,
      equipment: '徒手',
      duration: '30 秒',
      reps: 10,
      target: 'fixture',
      targetTone: 'coral',
      cue: 'fixture',
      tips: [],
      steps: [],
      breathing: 'fixture',
      reminders: [],
      videoLabel: 'fixture',
      videoStatus: 'approved',
      media: { videoStatus: 'approved', voiceChoices: [] },
    }],
  }
}

function stateWithPlans(plans: TrainingPlan[], activePlan = plans[0], selectedVoiceId = 'low') {
  return migrateLegacyWorkoutDataV2(
    { activePlan, savedPlans: plans, selectedVoiceId },
    { source: 'legacy-local', migratedAt: ISO, knownVoiceIds: KNOWN_VOICES },
  ).state
}

function faultInjectedStorage(initial: LocalWorkoutStateV2) {
  const durable = new Map<string, unknown>([[WORKOUT_DATA_V2_KEY, initial]])
  const volatile = new Map<string, unknown>()
  let failedRootWrites = 1
  const adapter = {
    async get<T>(key: string) {
      return ((volatile.has(key) ? volatile.get(key) : durable.get(key)) as T | undefined) ?? null
    },
    async set<T>(key: string, value: T) {
      if (key === WORKOUT_DATA_V2_KEY && failedRootWrites > 0) {
        failedRootWrites -= 1
        volatile.set(key, value)
        return { backend: 'memory', persisted: false }
      }
      durable.set(key, value)
      volatile.delete(key)
      return { backend: 'localStorage', persisted: true }
    },
  }
  return { durable, volatile, adapter, allowRootWrites: () => { failedRootWrites = 0 } }
}

function appHarness(initial: LocalWorkoutStateV2) {
  const storage = faultInjectedStorage(initial)
  let ui: WorkoutPlanUiSnapshotV2 = projectWorkoutPlanStateForUiV2(initial, PLAN_UI_CONTEXT)
  let notice = ''
  let commits = 0
  const execute = (command: WorkoutAppMutationCommandV2, successNotice: string) => executeWorkoutAppMutationV2({
    adapter: storage.adapter,
    command,
    migratedAt: ISO_2,
    knownVoiceIds: KNOWN_VOICES,
    planUiContext: PLAN_UI_CONTEXT,
    successNotice,
    setNotice: (value) => { notice = value },
    onCommitted: (commit) => { commits += 1; ui = commit.snapshot },
  })
  return { storage, execute, get ui() { return ui }, get notice() { return notice }, get commits() { return commits } }
}

function assertRootFailureIsInvisible(harness: ReturnType<typeof appHarness>, initial: LocalWorkoutStateV2, initialUi: WorkoutPlanUiSnapshotV2) {
  assert.equal(harness.commits, 0)
  assert.deepEqual(harness.ui, initialUi)
  assert.equal(harness.notice, WORKOUT_APP_RETRY_NOTICE)
  assert.equal(canonicalJson(harness.storage.durable.get(WORKOUT_DATA_V2_KEY)), canonicalJson(initial))
  assert.equal(harness.storage.durable.has(LEGACY_WORKOUT_STORAGE_KEYS.activePlan), false)
  assert.equal(harness.storage.durable.has(LEGACY_WORKOUT_STORAGE_KEYS.savedPlans), false)
  assert.equal(harness.storage.durable.has(LEGACY_WORKOUT_STORAGE_KEYS.selectedVoice), false)
}

test('APP-ROOT-01 plan creation is invisible on root failure and retry is refresh-visible', async () => {
  const initial = createFreshLocalWorkoutStateV2(ISO, 'low')
  const harness = appHarness(initial)
  const initialUi = structuredClone(harness.ui)
  const plan = personalPlan('created-plan')
  assert.equal((await harness.execute({ type: 'save_plan', plan }, 'saved')).ok, false)
  assertRootFailureIsInvisible(harness, initial, initialUi)

  harness.storage.allowRootWrites()
  assert.equal((await harness.execute({ type: 'save_plan', plan }, 'saved')).ok, true)
  assert.equal(harness.notice, 'saved')
  assert.deepEqual(harness.ui.savedPlans.map((item) => item.id), ['created-plan'])
  assert.deepEqual((harness.storage.durable.get(LEGACY_WORKOUT_STORAGE_KEYS.savedPlans) as TrainingPlan[]).map((item) => item.id), ['created-plan'])

  const refreshedAdapter = {
    async get<T>(key: string) { return (harness.storage.durable.get(key) as T | undefined) ?? null },
    async set<T>(key: string, value: T) { harness.storage.durable.set(key, value); return { backend: 'localStorage', persisted: true } },
  }
  const refreshed = await loadOrMigrateWorkoutDataV2(refreshedAdapter, { completedAt: ISO_2, knownVoiceIds: KNOWN_VOICES })
  assert.deepEqual(projectWorkoutPlanStateForUiV2(refreshed.state, PLAN_UI_CONTEXT).savedPlans.map((item) => item.id), ['created-plan'])
})

test('APP-ROOT-02 rename leaves UI and legacy untouched on failure, then converges on retry', async () => {
  const plan = personalPlan('rename-plan')
  const initial = stateWithPlans([plan])
  const harness = appHarness(initial)
  const initialUi = structuredClone(harness.ui)
  const command = { type: 'rename_plan', planId: plan.id, title: '可靠的新名称' } as const
  assert.equal((await harness.execute(command, 'renamed')).ok, false)
  assertRootFailureIsInvisible(harness, initial, initialUi)
  harness.storage.allowRootWrites()
  assert.equal((await harness.execute(command, 'renamed')).ok, true)
  assert.equal(harness.ui.savedPlans[0].title, '可靠的新名称')
  assert.equal((harness.storage.durable.get(LEGACY_WORKOUT_STORAGE_KEYS.savedPlans) as TrainingPlan[])[0].title, '可靠的新名称')
})

test('APP-ROOT-03 delete leaves the selected plan intact on failure, then removes it on retry', async () => {
  const plan = personalPlan('delete-plan')
  const initial = stateWithPlans([plan])
  const harness = appHarness(initial)
  const initialUi = structuredClone(harness.ui)
  const command = { type: 'delete_plan', planId: plan.id } as const
  assert.equal((await harness.execute(command, 'deleted')).ok, false)
  assertRootFailureIsInvisible(harness, initial, initialUi)
  harness.storage.allowRootWrites()
  assert.equal((await harness.execute(command, 'deleted')).ok, true)
  assert.equal(harness.ui.savedPlans.length, 0)
  assert.equal(harness.ui.activePlan.source, 'preset')
  assert.deepEqual(harness.storage.durable.get(LEGACY_WORKOUT_STORAGE_KEYS.savedPlans), [])
})

test('APP-ROOT-04 voice selection changes neither UI nor legacy on failure and retries durably', async () => {
  const initial = createFreshLocalWorkoutStateV2(ISO, 'low')
  const harness = appHarness(initial)
  const initialUi = structuredClone(harness.ui)
  const command = { type: 'select_voice', voiceId: 'clear' } as const
  assert.equal((await harness.execute(command, '')).ok, false)
  assertRootFailureIsInvisible(harness, initial, initialUi)
  harness.storage.allowRootWrites()
  assert.equal((await harness.execute(command, '')).ok, true)
  assert.equal(harness.ui.selectedVoiceId, 'clear')
  assert.equal(harness.storage.durable.get(LEGACY_WORKOUT_STORAGE_KEYS.selectedVoice), 'clear')
})

test('APP-ROOT-05 applying an editor context waits for the authoritative root', async () => {
  const first = personalPlan('apply-first')
  const second = personalPlan('apply-second', 'forearm-plank')
  const initial = stateWithPlans([first, second], first)
  const harness = appHarness(initial)
  const initialUi = structuredClone(harness.ui)
  const command = { type: 'apply_plan', planId: second.id } as const
  assert.equal((await harness.execute(command, 'applied')).ok, false)
  assertRootFailureIsInvisible(harness, initial, initialUi)
  harness.storage.allowRootWrites()
  assert.equal((await harness.execute(command, 'applied')).ok, true)
  assert.equal(harness.ui.activePlan.id, second.id)
  assert.equal((harness.storage.durable.get(LEGACY_WORKOUT_STORAGE_KEYS.activePlan) as TrainingPlan).id, second.id)
})

test('APP-ROOT-06 concurrent plan saves serialize from the latest committed root', async () => {
  const initial = createFreshLocalWorkoutStateV2(ISO, 'low')
  const storage = faultInjectedStorage(initial)
  storage.allowRootWrites()
  const notices: string[] = []
  const savedIds: string[][] = []
  const run = (plan: TrainingPlan) => executeWorkoutAppMutationV2({
    adapter: storage.adapter,
    command: { type: 'save_plan', plan },
    migratedAt: ISO_2,
    knownVoiceIds: KNOWN_VOICES,
    planUiContext: PLAN_UI_CONTEXT,
    successNotice: 'saved',
    setNotice: (notice) => notices.push(notice),
    onCommitted: ({ snapshot }) => savedIds.push(snapshot.savedPlans.map((item) => item.id)),
  })
  await Promise.all([run(personalPlan('parallel-a')), run(personalPlan('parallel-b', 'forearm-plank'))])
  const root = storage.durable.get(WORKOUT_DATA_V2_KEY) as LocalWorkoutStateV2
  assert.deepEqual(projectWorkoutPlanStateForUiV2(root, PLAN_UI_CONTEXT).savedPlans.map((item) => item.id).sort(), ['parallel-a', 'parallel-b'])
  assert.deepEqual(savedIds.at(-1)?.sort(), ['parallel-a', 'parallel-b'])
  assert.deepEqual(notices, ['saved', 'saved'])
})

test('APP-ROOT-07 App uses the awaited transaction entry and has no direct plan/voice legacy writes', () => {
  const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')
  assert.match(app, /const commitPlanMutation = \(/)
  assert.match(app, /await commitPlanMutation\(\{ type: 'save_plan'/)
  assert.match(app, /await commitPlanMutation\(\{ type: 'rename_plan'/)
  assert.match(app, /await commitPlanMutation\(\{ type: 'delete_plan'/)
  assert.match(app, /command: \{ type: 'select_voice'/)
  assert.match(app, /if \(!await prepare\(\)\) return/)
  assert.doesNotMatch(app, /persistWorkoutPlanSnapshot/)
  assert.doesNotMatch(app, /void storage\.set\((?:STORAGE_KEYS\.plans|'active-plan'|'selected-voice')/)
})

test('APP-ROOT-08 a failed legacy mirror never emits a false success after root commit', async () => {
  const initial = createFreshLocalWorkoutStateV2(ISO, 'low')
  const durable = new Map<string, unknown>([[WORKOUT_DATA_V2_KEY, initial]])
  let notice = ''
  let commits = 0
  const result = await executeWorkoutAppMutationV2({
    adapter: {
      async get<T>(key: string) { return (durable.get(key) as T | undefined) ?? null },
      async set<T>(key: string, value: T) {
        if (key === WORKOUT_DATA_V2_KEY) {
          durable.set(key, value)
          return { backend: 'localStorage', persisted: true }
        }
        return { backend: 'memory', persisted: false }
      },
    },
    command: { type: 'select_voice', voiceId: 'clear' },
    migratedAt: ISO_2,
    knownVoiceIds: KNOWN_VOICES,
    planUiContext: PLAN_UI_CONTEXT,
    successNotice: 'must-not-be-shown',
    setNotice: (value) => { notice = value },
    onCommitted: () => { commits += 1 },
  })
  assert.equal(result.ok, true)
  assert.equal(commits, 1)
  assert.equal(notice, WORKOUT_APP_LEGACY_WARNING_NOTICE)
  assert.equal((durable.get(WORKOUT_DATA_V2_KEY) as LocalWorkoutStateV2).selectedVoiceId, 'clear')
  assert.equal(durable.has(LEGACY_WORKOUT_STORAGE_KEYS.selectedVoice), false)
})
