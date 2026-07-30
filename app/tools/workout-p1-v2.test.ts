import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  WORKOUT_BACKUP_FORMAT,
  WorkoutP1Error,
  canonicalJson,
  sha256Hex,
  validateCompletedSessionV2,
  validateWorkoutPlanRecordV2,
  type LocalWorkoutStateV2,
} from '../src/workout/contracts-v2.ts'
import {
  createCompletedSessionV2,
  upsertCompletedSessionV2,
  upsertStoredCompletedSessionV2,
} from '../src/workout/completed-session-v2.ts'
import {
  DEFAULT_WORKOUT_RESOURCE_CATALOG_V2,
  createFixedWorkoutPlanRecordV2,
  createFreshLocalWorkoutStateV2,
  materializeWorkoutPlanV2,
  migrateLegacyWorkoutDataV2,
} from '../src/workout/plan-migration-v2.ts'
import {
  backupPayloadRoundTripEqual,
  exportWorkoutBackupV2,
  importWorkoutBackupV2,
  previewWorkoutBackupImportV2,
} from '../src/workout/backup-v2.ts'
import { runWorkoutDataPreflightV2 } from '../src/workout/preflight-v2.ts'
import { loadOrMigrateWorkoutDataV2 } from '../src/workout/workout-data-v2.ts'
import {
  advanceWorkoutRuntime,
  buildWorkoutSegments,
  createWorkoutRuntime,
  enterWorkoutDetail,
  exitWorkoutRuntime,
  getWorkoutSnapshot,
  guidedWorkoutPlanV2,
  pauseWorkoutRuntime,
  resumeWorkoutRuntime,
  skipWorkoutSegment,
  startWorkoutRuntime,
  type WorkoutRuntimeV2,
} from '../src/workout/runtime.ts'

const ISO = '2026-07-29T12:00:00.000Z'
const ISO_2 = '2026-07-29T12:01:00.000Z'

function legacyPlan(id: string, source: 'preset' | 'personal', exerciseIds: string[], rounds = 2) {
  return {
    id, title: `fixture-${id}`, subtitle: 'fixture', duration: 10, rounds, estimatedCalories: 42, source,
    exercises: exerciseIds.map((exerciseId) => ({
      id: exerciseId, name: `fixture-${exerciseId}`, equipment: '徒手', duration: '30 秒', reps: 10, target: 'fixture',
      targetTone: 'coral', cue: 'fixture', tips: [], steps: [], breathing: 'fixture', reminders: [],
      videoLabel: 'fixture', videoStatus: 'approved', media: { videoStatus: 'approved', voiceChoices: [] },
    })),
  }
}

function finishRuntime(runtime: WorkoutRuntimeV2, nowMs: number) {
  let next = runtime
  let now = nowMs
  while (next.state !== 'completed') {
    const snapshot = getWorkoutSnapshot(next, guidedWorkoutPlanV2, now)
    assert.ok(snapshot.segmentRemainingMs > 0, `segment ${snapshot.segment.id} must advance`)
    now += snapshot.segmentRemainingMs
    next = advanceWorkoutRuntime(next, guidedWorkoutPlanV2, now).runtime
  }
  return { runtime: next, now }
}

function completedRuntime(sessionId: string, startedAt = 0) {
  const started = startWorkoutRuntime(createWorkoutRuntime(guidedWorkoutPlanV2, sessionId), guidedWorkoutPlanV2, startedAt)
  return finishRuntime(started, startedAt).runtime
}

function completedSession(sessionId: string) {
  return createCompletedSessionV2({ runtime: completedRuntime(sessionId), plan: guidedWorkoutPlanV2, completedAt: ISO, estimatedCalories: 96 })
}

function fakeStorage(initial?: LocalWorkoutStateV2, persistent = true) {
  const values = new Map<string, unknown>()
  if (initial) values.set('workout-data-v2', initial)
  let writes = 0
  return {
    values,
    get writes() { return writes },
    adapter: {
      async get<T>(key: string) { return (values.get(key) as T | undefined) ?? null },
      async set<T>(key: string, value: T) {
        writes += 1
        values.set(key, value)
        return { backend: persistent ? 'localStorage' : 'memory', persisted: persistent }
      },
    },
  }
}

function expectCode(action: () => unknown, code: string) {
  assert.throws(action, (error: unknown) => error instanceof WorkoutP1Error && error.code === code)
}

test('P1-CS-01 CompletedSessionV2 schema strictly validates fields and boundaries', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const valid = completedSession('schema-valid')
  assert.equal(validateCompletedSessionV2(valid, buildWorkoutSegments(guidedWorkoutPlanV2).map((segment) => segment.id)).ok, true)
  assert.equal(validateCompletedSessionV2({ ...valid, activeElapsedMs: -1 }).ok, false)
  assert.equal(validateCompletedSessionV2({ ...valid, completedAt: 'not-an-iso' }).ok, false)
  assert.equal(validateCompletedSessionV2({ ...valid, sessionId: ` ${valid.sessionId}` }).ok, false)
})

test('P1-CS-02 only a completed runtime can generate CompletedSessionV2', () => {
  const idle = createWorkoutRuntime(guidedWorkoutPlanV2, 'not-completed')
  const active = startWorkoutRuntime(idle, guidedWorkoutPlanV2, 0)
  expectCode(() => createCompletedSessionV2({ runtime: active, plan: guidedWorkoutPlanV2, completedAt: ISO, estimatedCalories: 96 }), 'SESSION_NOT_COMPLETED')
  expectCode(() => createCompletedSessionV2({ runtime: exitWorkoutRuntime(active), plan: guidedWorkoutPlanV2, completedAt: ISO, estimatedCalories: 96 }), 'SESSION_NOT_COMPLETED')
})

test('P1-CS-03 pause, detail and background freeze active time while wall time continues', () => {
  let runtime = startWorkoutRuntime(createWorkoutRuntime(guidedWorkoutPlanV2, 'timing'), guidedWorkoutPlanV2, 1_000)
  runtime = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 31_000).runtime
  runtime = pauseWorkoutRuntime(runtime, guidedWorkoutPlanV2, 35_000, 'background').runtime
  runtime = resumeWorkoutRuntime(runtime, 65_000)
  runtime = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 69_000).runtime
  runtime = enterWorkoutDetail(runtime, guidedWorkoutPlanV2, 70_000).runtime
  runtime = { ...runtime, state: 'paused', pauseReason: 'detail_return' }
  runtime = resumeWorkoutRuntime(runtime, 90_000)
  const finished = finishRuntime(runtime, 90_000).runtime
  const session = createCompletedSessionV2({ runtime: finished, plan: guidedWorkoutPlanV2, completedAt: ISO, estimatedCalories: 96 })
  assert.equal(session.activeElapsedMs, 882_000)
  assert.equal(session.wallElapsedMs, 932_000)
  assert.ok(session.activeElapsedMs < session.wallElapsedMs)
})

test('P1-CS-04 completed and skipped segment sets are ordered, disjoint and exhaustive', () => {
  let runtime = startWorkoutRuntime(createWorkoutRuntime(guidedWorkoutPlanV2, 'skip-segment'), guidedWorkoutPlanV2, 0)
  runtime = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 32_000).runtime
  runtime = skipWorkoutSegment(runtime, guidedWorkoutPlanV2, 34_000).runtime
  const finished = finishRuntime(runtime, 34_000).runtime
  const session = createCompletedSessionV2({ runtime: finished, plan: guidedWorkoutPlanV2, completedAt: ISO, estimatedCalories: 96 })
  assert.deepEqual(session.skippedSegmentIds, ['round-1-exercise-1'])
  assert.equal(session.completedSegmentIds.length + session.skippedSegmentIds.length, 25)
  assert.equal(session.roundsCompleted, 2)
})

test('P1-CS-05 duplicate completion callbacks are no-op and write one revision', async () => {
  const state = createFreshLocalWorkoutStateV2(ISO)
  const storage = fakeStorage(state)
  const record = completedSession('duplicate-completion')
  const [first, second] = await Promise.all([
    upsertStoredCompletedSessionV2(storage.adapter, record, state),
    upsertStoredCompletedSessionV2(storage.adapter, record, state),
  ])
  assert.deepEqual([first.inserted, second.inserted], [true, false])
  assert.equal(storage.writes, 1)
  assert.equal(second.record.completedAt, ISO)
})

test('P1-CS-06 same sessionId with different canonical facts raises SESSION_CONFLICT', () => {
  const state = createFreshLocalWorkoutStateV2(ISO)
  const first = completedSession('conflict')
  const inserted = upsertCompletedSessionV2(state, first).state
  expectCode(() => upsertCompletedSessionV2(inserted, { ...first, completedAt: ISO_2 }), 'SESSION_CONFLICT')
  assert.equal(inserted.sessions[0].completedAt, ISO)
})

test('P1-CS-07 concurrent sessions survive queueing and memory-only persistence is rejected', async () => {
  const state = createFreshLocalWorkoutStateV2(ISO)
  const durable = fakeStorage(state)
  await Promise.all([
    upsertStoredCompletedSessionV2(durable.adapter, completedSession('concurrent-a'), state),
    upsertStoredCompletedSessionV2(durable.adapter, completedSession('concurrent-b'), state),
  ])
  assert.equal((durable.values.get('workout-data-v2') as LocalWorkoutStateV2).sessions.length, 2)
  const volatile = fakeStorage(state, false)
  await assert.rejects(upsertStoredCompletedSessionV2(volatile.adapter, completedSession('volatile'), state), (error: unknown) => error instanceof WorkoutP1Error && error.code === 'BACKUP_PERSIST_FAILED')
  await assert.rejects(upsertStoredCompletedSessionV2(volatile.adapter, completedSession('volatile'), state), (error: unknown) => error instanceof WorkoutP1Error && error.code === 'BACKUP_PERSIST_FAILED')
  assert.equal(volatile.writes, 2)
})

test('P1-CS-08 legacy and P0 completion records remain envelopes without invented V2 facts', () => {
  const p0 = { completedAt: ISO, rounds: 3, skipped: 0, estimatedCalories: 96, sessionId: 'p0', completionEventId: 'p0/workout/completed/1' }
  const old = { completedAt: ISO_2, rounds: 2, skipped: 1, estimatedCalories: 50 }
  const preview = migrateLegacyWorkoutDataV2({ sessions: [p0, old], lastSession: old }, { source: 'legacy-local', migratedAt: ISO, knownVoiceIds: ['low'] })
  assert.equal(preview.state.sessions.length, 0)
  assert.deepEqual(new Set(preview.state.legacySessions.map((entry) => entry.kind)), new Set(['workout-completion-record-p0', 'completed-session']))
})

test('P1-PL-01 plan schema covers all counting modes and rejects mixed targets or URI storage', () => {
  const fixed = createFixedWorkoutPlanRecordV2()
  assert.equal(validateWorkoutPlanRecordV2(fixed).ok, true)
  const personal = migrateLegacyWorkoutDataV2({ savedPlans: [legacyPlan('three-modes', 'personal', ['bodyweight-squat', 'forearm-plank', 'dumbbell-biceps-curl'])] }, { source: 'legacy-local', migratedAt: ISO, knownVoiceIds: [] }).state.plans.find((plan) => plan.id === 'three-modes')!
  assert.deepEqual(personal.exercises.map((exercise) => exercise.counting.mode), ['repetition', 'timed', 'alternating_pair'])
  const broken = structuredClone(personal) as any
  broken.exercises[0].counting.targetSeconds = 10
  assert.equal(validateWorkoutPlanRecordV2(broken).ok, false)
  assert.equal(validateWorkoutPlanRecordV2({ ...personal, videoUri: '/must-not-be-stored' }).ok, false)
  assert.doesNotMatch(canonicalJson(personal), /videoUri|posterUri|countAudioVariants/)
})

test('P1-PL-02 canonical fixed record resolves to the unchanged 25-segment 882000ms plan', () => {
  const materialized = materializeWorkoutPlanV2(createFixedWorkoutPlanRecordV2())
  assert.equal(canonicalJson(materialized), canonicalJson(guidedWorkoutPlanV2))
  assert.equal(buildWorkoutSegments(materialized).length, 25)
  assert.equal(materialized.plannedDurationMs, 882_000)
})

test('P1-PL-03 all eight preset identities and unknown preset use exact mapping statuses', () => {
  const presetIds = ['lower-body-foundation-v0-2', 'lower-body-guided-15m-v2', 'quick-lower-body-v0-1', 'bodyweight-home-v0-1', 'chair-friendly-v0-1', 'dumbbell-lower-body-v0-1', 'upper-core-foundation-v0-1', 'full-body-foundation-v0-1']
  const fixedExercises = ['goblet-squat', 'romanian-deadlift', 'reverse-lunge', 'glute-bridge']
  const preview = migrateLegacyWorkoutDataV2({ savedPlans: [...presetIds.map((id) => legacyPlan(id, 'preset', id.startsWith('lower-body-') && !id.includes('quick') ? fixedExercises : [], id.startsWith('lower-body-') && !id.includes('quick') ? 3 : 2)), legacyPlan('unknown-preset', 'preset', [])] }, { source: 'legacy-local', migratedAt: ISO, knownVoiceIds: [] })
  assert.deepEqual(preview.entities.slice(0, 2).map((entry) => entry.status), ['migrated', 'migrated'])
  assert.ok(preview.entities.slice(2, 8).every((entry) => entry.status === 'preserved' && entry.code === 'unsupported_system_preset'))
  assert.equal(preview.entities[8].code, 'unknown_system_preset')
})

test('P1-PL-04 personal migration creates only a save_only shadow and preserves the original', () => {
  const preview = migrateLegacyWorkoutDataV2({ activePlan: legacyPlan('personal-valid', 'personal', ['bodyweight-squat', 'forearm-plank']) }, { source: 'legacy-local', migratedAt: ISO, knownVoiceIds: [] })
  const shadow = preview.state.plans.find((plan) => plan.id === 'personal-valid')!
  assert.equal(shadow.executionPolicy, 'save_only')
  assert.equal(preview.state.legacyPlans.length, 1)
  assert.equal(preview.state.fixedRuntimePlanId, 'lower-body-guided-15m-v2')
})

test('P1-PL-05 missing rule, ID conflict and duration mismatch reject without overwriting legacy', () => {
  const conflicting = [legacyPlan('same-id', 'personal', ['bodyweight-squat']), legacyPlan('same-id', 'personal', ['forearm-plank'])]
  const preview = migrateLegacyWorkoutDataV2({ savedPlans: [legacyPlan('missing-rule', 'personal', ['not-registered']), ...conflicting] }, { source: 'legacy-local', migratedAt: ISO, knownVoiceIds: [] })
  assert.equal(preview.entities[0].code, 'MIGRATION_RULE_MISSING')
  assert.equal(preview.entities[2].code, 'MIGRATION_ID_CONFLICT')
  assert.equal(preview.state.legacyPlans.length, 3)
  const fixed = createFixedWorkoutPlanRecordV2()
  assert.ok(validateWorkoutPlanRecordV2({ ...fixed, plannedDurationMs: fixed.plannedDurationMs + 1 }).issues.some((entry) => entry.code === 'PLAN_DURATION_MISMATCH'))
})

test('P1-PL-06 identical fingerprints deduplicate without new plan revisions', () => {
  const plan = legacyPlan('repeat-personal', 'personal', ['bodyweight-squat'])
  const preview = migrateLegacyWorkoutDataV2({ savedPlans: [plan, structuredClone(plan)] }, { source: 'legacy-local', migratedAt: ISO, knownVoiceIds: [] })
  assert.equal(preview.state.plans.filter((entry) => entry.id === plan.id).length, 1)
  assert.deepEqual(preview.entities.map((entry) => entry.status), ['migrated', 'deduplicated'])
})

test('P1-BK-01 v2 export contains canonical normalized JSON references only', () => {
  const backup = exportWorkoutBackupV2(createFreshLocalWorkoutStateV2(ISO, 'low'), ISO_2)
  assert.equal(backup.version, 2)
  assert.equal(backup.format, WORKOUT_BACKUP_FORMAT)
  assert.doesNotMatch(canonicalJson(backup.payload), /videoUri|posterUri|Blob|timelineEvents/)
})

test('P1-BK-02 v1 import restores data context without changing fixed runtime identity', () => {
  const personal = legacyPlan('backup-personal', 'personal', ['bodyweight-squat'])
  const backup = { format: WORKOUT_BACKUP_FORMAT, version: 1, activePlan: personal, savedPlans: [personal], sessions: [{ completedAt: ISO, rounds: 2, skipped: 0, estimatedCalories: 42 }], lastSession: null, selectedVoiceId: 'unknown' }
  const preview = previewWorkoutBackupImportV2(JSON.stringify(backup), { importedAt: ISO_2, knownVoiceIds: ['low'] })
  assert.equal(preview.state.fixedRuntimePlanId, 'lower-body-guided-15m-v2')
  assert.equal(preview.state.plans.find((plan) => plan.id === personal.id)?.executionPolicy, 'save_only')
  assert.equal(preview.state.selectedVoiceId, null)
  assert.ok(preview.issues.some((entry) => entry.code === 'UNKNOWN_VOICE_ID'))
})

test('P1-BK-03 v2 export-import-export payload roundtrip is canonical deep equal', () => {
  assert.equal(backupPayloadRoundTripEqual(createFreshLocalWorkoutStateV2(ISO, 'low'), ISO, ISO_2), true)
})

test('P1-BK-04 invalid JSON, nested schema and broken references fail before storage writes', async () => {
  const storage = fakeStorage()
  await assert.rejects(importWorkoutBackupV2(storage.adapter, '{bad', { importedAt: ISO, knownVoiceIds: ['low'] }), (error: unknown) => error instanceof WorkoutP1Error && error.code === 'BACKUP_INVALID_JSON')
  const missing = JSON.stringify({ format: WORKOUT_BACKUP_FORMAT, version: 1, savedPlans: [], sessions: [] })
  await assert.rejects(importWorkoutBackupV2(storage.adapter, missing, { importedAt: ISO, knownVoiceIds: ['low'] }), (error: unknown) => error instanceof WorkoutP1Error && error.code === 'BACKUP_SCHEMA_INVALID')
  const state = createFreshLocalWorkoutStateV2(ISO)
  state.plans[0].exercises[0].motionAssetRef.revision = 'missing'
  await assert.rejects(importWorkoutBackupV2(storage.adapter, JSON.stringify({ format: WORKOUT_BACKUP_FORMAT, version: 2, exportedAt: ISO, payload: state }), { importedAt: ISO, knownVoiceIds: ['low'] }), (error: unknown) => error instanceof WorkoutP1Error && error.code === 'BACKUP_SCHEMA_INVALID')
  assert.equal(storage.writes, 0)
})

test('P1-BK-05 unknown numeric and string versions are rejected without guessing', () => {
  for (const version of [0, 3, '2']) expectCode(() => previewWorkoutBackupImportV2(JSON.stringify({ format: WORKOUT_BACKUP_FORMAT, version }), { importedAt: ISO, knownVoiceIds: [] }), 'BACKUP_UNSUPPORTED_VERSION')
})

test('P1-BK-06 backup import performs one root write and exposes persistent failure', async () => {
  const state = createFreshLocalWorkoutStateV2(ISO)
  const text = JSON.stringify(exportWorkoutBackupV2(state, ISO_2))
  const durable = fakeStorage()
  await importWorkoutBackupV2(durable.adapter, text, { importedAt: ISO, knownVoiceIds: [] })
  assert.equal(durable.writes, 1)
  const volatile = fakeStorage(undefined, false)
  await assert.rejects(importWorkoutBackupV2(volatile.adapter, text, { importedAt: ISO, knownVoiceIds: [] }), (error: unknown) => error instanceof WorkoutP1Error && error.code === 'BACKUP_PERSIST_FAILED')

  const legacyValues = new Map<string, unknown>([['active-plan', legacyPlan('legacy-startup', 'personal', ['bodyweight-squat'])], ['saved-plans', [legacyPlan('legacy-startup', 'personal', ['bodyweight-squat'])]]])
  let legacyWrites = 0
  const legacyAdapter = {
    async get<T>(key: string) { return (legacyValues.get(key) as T | undefined) ?? null },
    async set<T>(key: string, value: T) { legacyWrites += 1; legacyValues.set(key, value); return { backend: 'localStorage', persisted: true } },
  }
  const migrated = await loadOrMigrateWorkoutDataV2(legacyAdapter, { completedAt: ISO, knownVoiceIds: ['low'] })
  assert.equal(migrated.source, 'legacy-local')
  assert.equal(legacyWrites, 1)
  assert.equal(legacyValues.has('active-plan'), true)
  assert.equal(legacyValues.has('saved-plans'), true)

  const invalidValues = new Map<string, unknown>([['workout-data-v2', { schemaVersion: 2, broken: true }], ['active-plan', legacyPlan('must-not-fallback', 'personal', ['bodyweight-squat'])]])
  let invalidWrites = 0
  const invalidAdapter = {
    async get<T>(key: string) { return (invalidValues.get(key) as T | undefined) ?? null },
    async set() { invalidWrites += 1; return { backend: 'localStorage', persisted: true } },
  }
  await assert.rejects(loadOrMigrateWorkoutDataV2(invalidAdapter, { completedAt: ISO, knownVoiceIds: ['low'] }), (error: unknown) => error instanceof WorkoutP1Error && error.code === 'BACKUP_SCHEMA_INVALID')
  assert.equal(invalidWrites, 0)
})

test('P1-PF-01 current fixed workout remains the sole ready runtime entry', () => {
  const preflight = runWorkoutDataPreflightV2(createFreshLocalWorkoutStateV2(ISO))
  assert.equal(preflight.fixedRuntimeReady, true)
  assert.equal(preflight.fixedRuntimePlanId, 'lower-body-guided-15m-v2')
  assert.equal(preflight.issues.length, 0)
})

test('P1-PF-02 personal headless readiness reports data only and never enables runtime', () => {
  const state = migrateLegacyWorkoutDataV2({ savedPlans: [legacyPlan('preflight-personal', 'personal', ['bodyweight-squat'])] }, { source: 'legacy-local', migratedAt: ISO, knownVoiceIds: [] }).state
  const ready = runWorkoutDataPreflightV2(state)
  assert.deepEqual(ready.personalPlanDataReadyIds, ['preflight-personal'])
  assert.equal(ready.personalPlanRuntimeEnabled, false)
  const missingCatalog = structuredClone(DEFAULT_WORKOUT_RESOURCE_CATALOG_V2)
  delete missingCatalog.exercises['bodyweight-squat']
  const missing = runWorkoutDataPreflightV2(state, missingCatalog)
  assert.deepEqual(missing.personalPlanDataReadyIds, [])
  assert.equal(missing.personalPlanRuntimeEnabled, false)
})

test('P1-PF-03 four audit JSON files contain hashes, cases and zero failures', () => {
  const auditRoot = join(process.cwd(), '..', 'audit', 'workout-v2')
  for (const filename of ['completed-session-v2.json', 'plan-migration.json', 'backup-schema-v2.json', 'personal-plan-runtime.json']) {
    const path = join(auditRoot, filename)
    assert.equal(existsSync(path), true, `${filename} must exist`)
    const audit = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(audit.contractVersion, 'workout-p1-architecture-contract/1')
    assert.ok(Object.keys(audit.sourceHashes).length > 0)
    assert.ok(audit.cases.length > 0)
    assert.deepEqual(audit.summary, { passed: audit.cases.length, failed: 0 })
  }
})

test('P1-SC-01 App navigation and workout entry remain fixed with no personal runtime CTA', () => {
  const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')
  assert.match(app, /useWorkoutClock\(guidedWorkoutPlanV2/)
  assert.match(app, /<WorkoutScreenModal\b/)
  assert.match(app, /const workoutExercise = guidedWorkoutPlanV2\.exercises/)
  assert.match(app, /createCompletedSessionV2\(\{ runtime, plan: guidedWorkoutPlanV2/)
  assert.match(app, /upsertStoredCompletedSessionV2\(storage, sessionV2/)
  assert.match(app, /completionTimestampBySessionRef\.current\.get\(runtime\.sessionId\)/)
  assert.match(app, /serializeWorkoutBackupV2\(refreshed\.state/)
  assert.match(app, /importWorkoutBackupV2\(storage/)
  assert.doesNotMatch(app, /version:\s*1[\s,}]/)
  assert.doesNotMatch(app, /开始当前计划|保存并应用|从这个动作开始|加练一轮/)
  assert.doesNotMatch(app, /useWorkoutClock\(activePlan|useWorkoutClock\(.*personal/)
})
