import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WORKOUT_BACKUP_FORMAT,
  WorkoutP1Error,
  canonicalJson,
  validateWorkoutPlanRecordV2,
} from '../src/workout/contracts-v2.ts'
import { createCompletedSessionV2, upsertCompletedSessionV2, upsertStoredCompletedSessionV2 } from '../src/workout/completed-session-v2.ts'
import {
  DEFAULT_WORKOUT_RESOURCE_CATALOG_V2,
  createFixedWorkoutPlanRecordV2,
  createFreshLocalWorkoutStateV2,
  materializeWorkoutPlanV2,
  migrateLegacyWorkoutDataV2,
} from '../src/workout/plan-migration-v2.ts'
import { backupPayloadRoundTripEqual, exportWorkoutBackupV2, importWorkoutBackupV2, previewWorkoutBackupImportV2 } from '../src/workout/backup-v2.ts'
import { runWorkoutDataPreflightV2 } from '../src/workout/preflight-v2.ts'
import { advanceWorkoutRuntime, buildWorkoutSegments, createWorkoutRuntime, getWorkoutSnapshot, guidedWorkoutPlanV2, skipWorkoutSegment, startWorkoutRuntime } from '../src/workout/runtime.ts'

const appRoot = process.cwd()
const auditRoot = join(appRoot, '..', 'audit', 'workout-v2')
const generatedAt = new Date().toISOString()
const fixtureAt = '2026-07-29T12:00:00.000Z'

const sourceFiles = [
  'src/workout/contracts-v2.ts',
  'src/workout/runtime.ts',
  'src/workout/completed-session-v2.ts',
  'src/workout/plan-migration-v2.ts',
  'src/workout/workout-data-v2.ts',
  'src/workout/app-persistence-v2.ts',
  'src/workout/backup-v2.ts',
  'src/workout/preflight-v2.ts',
]
const sourceHashes = Object.fromEntries(sourceFiles.map((file) => [file, createHash('sha256').update(readFileSync(join(appRoot, file))).digest('hex')]))

function legacyPlan(id, source, exerciseIds, rounds = 2) {
  return {
    id, title: `fixture-${id}`, subtitle: 'fixture', duration: 10, rounds, estimatedCalories: 42, source,
    exercises: exerciseIds.map((exerciseId) => ({
      id: exerciseId, name: `fixture-${exerciseId}`, equipment: '徒手', duration: '30 秒', reps: 10, target: 'fixture',
      targetTone: 'coral', cue: 'fixture', tips: [], steps: [], breathing: 'fixture', reminders: [],
      videoLabel: 'fixture', videoStatus: 'approved', media: { videoStatus: 'approved', voiceChoices: [] },
    })),
  }
}

function completedRuntime(sessionId) {
  const started = startWorkoutRuntime(createWorkoutRuntime(guidedWorkoutPlanV2, sessionId), guidedWorkoutPlanV2, 0)
  return advanceWorkoutRuntime(started, guidedWorkoutPlanV2, guidedWorkoutPlanV2.plannedDurationMs).runtime
}

function session(sessionId) {
  return createCompletedSessionV2({ runtime: completedRuntime(sessionId), plan: guidedWorkoutPlanV2, completedAt: fixtureAt, estimatedCalories: 96 })
}

function skippedSession(sessionId) {
  let runtime = startWorkoutRuntime(createWorkoutRuntime(guidedWorkoutPlanV2, sessionId), guidedWorkoutPlanV2, 0)
  runtime = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 32_000).runtime
  runtime = skipWorkoutSegment(runtime, guidedWorkoutPlanV2, 34_000).runtime
  let now = 34_000
  while (runtime.state !== 'completed') {
    const snapshot = getWorkoutSnapshot(runtime, guidedWorkoutPlanV2, now)
    now += snapshot.segmentRemainingMs
    runtime = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, now).runtime
  }
  return createCompletedSessionV2({ runtime, plan: guidedWorkoutPlanV2, completedAt: fixtureAt, estimatedCalories: 96 })
}

function check(id, action, details = {}) {
  try {
    const result = action()
    if (result === false) throw new Error('predicate returned false')
    return { id, passed: true, ...details }
  } catch (error) {
    return { id, passed: false, error: error instanceof Error ? error.message : String(error), ...details }
  }
}

function expectCode(code, action) {
  try { action() } catch (error) { return error instanceof WorkoutP1Error && error.code === code }
  return false
}

function writeAudit(filename, cases) {
  const summary = { passed: cases.filter((item) => item.passed).length, failed: cases.filter((item) => !item.passed).length }
  const artifact = { contractVersion: 'workout-p1-architecture-contract/1', generatedAt, sourceHashes, cases, summary }
  writeFileSync(join(auditRoot, filename), `${JSON.stringify(artifact, null, 2)}\n`)
  if (summary.failed) throw new Error(`${filename} has ${summary.failed} failed audit cases`)
}

mkdirSync(auditRoot, { recursive: true })

const completed = session('audit-completed')
const skipped = skippedSession('audit-skipped')
const fresh = createFreshLocalWorkoutStateV2(fixtureAt)
const inserted = upsertCompletedSessionV2(fresh, completed)
const completionValues = new Map([['workout-data-v2', fresh]])
let completionPersistenceRejected = false
try {
  await upsertStoredCompletedSessionV2({
    async get(key) { return completionValues.get(key) ?? null },
    async set(key, value) { completionValues.set(key, value); return { backend: 'memory', persisted: false } },
  }, session('audit-volatile'), fresh)
} catch (error) { completionPersistenceRejected = error instanceof WorkoutP1Error && error.code === 'BACKUP_PERSIST_FAILED' }
writeAudit('completed-session-v2.json', [
  check('schema-and-timing', () => completed.plannedDurationMs === 882000 && completed.activeElapsedMs === 882000 && completed.wallElapsedMs === 882000, { plannedDurationMs: completed.plannedDurationMs, activeElapsedMs: completed.activeElapsedMs, wallElapsedMs: completed.wallElapsedMs }),
  check('segment-cover', () => completed.completedSegmentIds.length === 25 && completed.skippedSegmentIds.length === 0, { completedSegmentCount: completed.completedSegmentIds.length, skippedSegmentCount: completed.skippedSegmentIds.length }),
  check('skipped-segment-facts', () => skipped.skippedSegmentIds.join(',') === 'round-1-exercise-1' && skipped.roundsCompleted === 2, { skippedSegmentIds: skipped.skippedSegmentIds, roundsCompleted: skipped.roundsCompleted }),
  check('duplicate-session-noop', () => upsertCompletedSessionV2(inserted.state, completed).inserted === false),
  check('conflicting-session-rejected', () => expectCode('SESSION_CONFLICT', () => upsertCompletedSessionV2(inserted.state, { ...completed, completedAt: '2026-07-29T12:01:00.000Z' }))),
  check('legacy-session-isolated', () => migrateLegacyWorkoutDataV2({ sessions: [{ completedAt: fixtureAt, rounds: 3, skipped: 0, estimatedCalories: 96 }] }, { source: 'legacy-local', migratedAt: fixtureAt, knownVoiceIds: [] }).state.sessions.length === 0),
  check('persistent-failure-covered', () => completionPersistenceRejected, { expectedErrorCode: 'BACKUP_PERSIST_FAILED' }),
])

const fixedIds = ['goblet-squat', 'romanian-deadlift', 'reverse-lunge', 'glute-bridge']
const presetIds = ['lower-body-foundation-v0-2', 'lower-body-guided-15m-v2', 'quick-lower-body-v0-1', 'bodyweight-home-v0-1', 'chair-friendly-v0-1', 'dumbbell-lower-body-v0-1', 'upper-core-foundation-v0-1', 'full-body-foundation-v0-1']
const presetPreview = migrateLegacyWorkoutDataV2({ savedPlans: [...presetIds.map((id) => legacyPlan(id, 'preset', id.startsWith('lower-body-') && !id.includes('quick') ? fixedIds : [], id.startsWith('lower-body-') && !id.includes('quick') ? 3 : 2)), legacyPlan('unknown-preset', 'preset', [])] }, { source: 'legacy-local', migratedAt: fixtureAt, knownVoiceIds: [] })
const personal = legacyPlan('audit-personal', 'personal', ['bodyweight-squat', 'forearm-plank'])
const personalPreview = migrateLegacyWorkoutDataV2({ savedPlans: [personal, personal, legacyPlan('missing-rule', 'personal', ['unknown-exercise'])] }, { source: 'legacy-local', migratedAt: fixtureAt, knownVoiceIds: [] })
const conflictPreview = migrateLegacyWorkoutDataV2({ savedPlans: [legacyPlan('audit-conflict', 'personal', ['bodyweight-squat']), legacyPlan('audit-conflict', 'personal', ['forearm-plank'])] }, { source: 'legacy-local', migratedAt: fixtureAt, knownVoiceIds: [] })
writeAudit('plan-migration.json', [
  ...presetPreview.entities.map((entry) => check(`preset:${entry.entityId}`, () => entry.status !== undefined, { status: entry.status, code: entry.code ?? null })),
  check('personal-shadow-save-only', () => personalPreview.state.plans.find((plan) => plan.id === personal.id)?.executionPolicy === 'save_only'),
  check('personal-original-preserved', () => personalPreview.state.legacyPlans.some((entry) => entry.data.id === personal.id)),
  check('personal-missing-rule', () => personalPreview.entities.some((entry) => entry.code === 'MIGRATION_RULE_MISSING')),
  check('personal-id-conflict', () => conflictPreview.entities.some((entry) => entry.code === 'MIGRATION_ID_CONFLICT')),
  check('personal-deduplicated', () => personalPreview.entities.some((entry) => entry.status === 'deduplicated')),
  check('empty-storage', () => createFreshLocalWorkoutStateV2(fixtureAt).plans.length === 1),
])

const v2Backup = exportWorkoutBackupV2(fresh, fixtureAt)
const v1Backup = { format: WORKOUT_BACKUP_FORMAT, version: 1, activePlan: personal, savedPlans: [personal], sessions: [], lastSession: null, selectedVoiceId: 'low' }
const brokenState = structuredClone(fresh)
brokenState.plans[0].exercises[0].motionAssetRef.revision = 'missing'
let backupPersistenceRejected = false
try {
  const volatileValues = new Map()
  await importWorkoutBackupV2({
    async get(key) { return volatileValues.get(key) ?? null },
    async set(key, value) { volatileValues.set(key, value); return { backend: 'memory', persisted: false } },
  }, JSON.stringify(v2Backup), { importedAt: fixtureAt, knownVoiceIds: [] })
} catch (error) { backupPersistenceRejected = error instanceof WorkoutP1Error && error.code === 'BACKUP_PERSIST_FAILED' }
writeAudit('backup-schema-v2.json', [
  check('v1-import', () => previewWorkoutBackupImportV2(JSON.stringify(v1Backup), { importedAt: fixtureAt, knownVoiceIds: ['low'] }).state.fixedRuntimePlanId === 'lower-body-guided-15m-v2'),
  check('v2-roundtrip', () => backupPayloadRoundTripEqual(fresh, fixtureAt, '2026-07-29T12:01:00.000Z')),
  check('invalid-json', () => expectCode('BACKUP_INVALID_JSON', () => previewWorkoutBackupImportV2('{bad', { importedAt: fixtureAt, knownVoiceIds: [] }))),
  check('format-mismatch', () => expectCode('BACKUP_FORMAT_MISMATCH', () => previewWorkoutBackupImportV2(JSON.stringify({ ...v2Backup, format: 'wrong' }), { importedAt: fixtureAt, knownVoiceIds: [] }))),
  check('unsupported-version', () => expectCode('BACKUP_UNSUPPORTED_VERSION', () => previewWorkoutBackupImportV2(JSON.stringify({ format: WORKOUT_BACKUP_FORMAT, version: 3 }), { importedAt: fixtureAt, knownVoiceIds: [] }))),
  check('deep-reference-damage', () => expectCode('BACKUP_SCHEMA_INVALID', () => previewWorkoutBackupImportV2(JSON.stringify({ ...v2Backup, payload: brokenState }), { importedAt: fixtureAt, knownVoiceIds: [] }))),
  check('persistent-failure-zero-commit', () => backupPersistenceRejected, { expectedErrorCode: 'BACKUP_PERSIST_FAILED' }),
])

const personalState = migrateLegacyWorkoutDataV2({ savedPlans: [legacyPlan('audit-three-modes', 'personal', ['bodyweight-squat', 'forearm-plank', 'dumbbell-biceps-curl'])] }, { source: 'legacy-local', migratedAt: fixtureAt, knownVoiceIds: [] }).state
const personalPreflight = runWorkoutDataPreflightV2(personalState)
const missingCatalog = structuredClone(DEFAULT_WORKOUT_RESOURCE_CATALOG_V2)
delete missingCatalog.exercises['bodyweight-squat']
const missingPreflight = runWorkoutDataPreflightV2(personalState, missingCatalog)
const fixedMaterialized = materializeWorkoutPlanV2(createFixedWorkoutPlanRecordV2())
writeAudit('personal-plan-runtime.json', [
  check('fixed-plan-sum', () => buildWorkoutSegments(fixedMaterialized).length === 25 && fixedMaterialized.plannedDurationMs === 882000),
  check('counting-modes', () => personalState.plans.find((plan) => plan.id === 'audit-three-modes')?.exercises.map((exercise) => exercise.counting.mode).join(',') === 'repetition,timed,alternating_pair'),
  check('plan-schema', () => validateWorkoutPlanRecordV2(createFixedWorkoutPlanRecordV2()).ok),
  check('fixed-preflight', () => runWorkoutDataPreflightV2(fresh).fixedRuntimeReady),
  check('personal-headless-ready', () => personalPreflight.personalPlanDataReadyIds.includes('audit-three-modes')),
  check('missing-resource-rejected', () => missingPreflight.personalPlanDataReadyIds.length === 0),
  check('personal-runtime-disabled', () => personalPreflight.personalPlanRuntimeEnabled === false && missingPreflight.personalPlanRuntimeEnabled === false, { personalPlanRuntimeEnabled: false }),
  check('fixed-runtime-canonical', () => canonicalJson(fixedMaterialized) === canonicalJson(guidedWorkoutPlanV2)),
])
