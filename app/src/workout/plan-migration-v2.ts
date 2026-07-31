import type { CompletedSession, TrainingPlan } from '../types'
import {
  FIXED_RUNTIME_PLAN_ID,
  WORKOUT_P1_CONTRACT_VERSION,
  WorkoutP1Error,
  calculatePlanRecordDurationMs,
  canonicalJson,
  canonicalizeLocalWorkoutStateV2,
  createLegacyEnvelopeV1,
  legacyFingerprint,
  isIsoUtc,
  validateLocalWorkoutStateV2,
  validateWorkoutPlanRecordV2,
  type CountingSpecV2,
  type LegacyEnvelopeV1,
  type LocalWorkoutStateV2,
  type PreflightIssueV2,
  type WorkoutExerciseV2,
  type WorkoutPlanRecordV2,
  type WorkoutPlanV2,
} from './contracts-v2.ts'
import { buildCountdownTimeline, guidedWorkoutPlanV2 } from './runtime.ts'

export type LegacyExerciseMigrationRuleV2 = {
  legacyExerciseId: string
  ruleRevision: string
  exerciseRevision: string
  counting: CountingSpecV2
  motionAssetRef: { assetId: string; revision: string }
  detailNarrationRef?: { assetId: string; revision: string }
}

export type WorkoutResourceCatalogV2 = {
  exercises: Record<string, {
    revision: string
    motionAssets: Record<string, { videoUri: string; videoFallbackUri?: string; posterUri: string }>
    detailNarrations?: Record<string, { uri: string; durationMs: number }>
  }>
  countAudioBanks: Record<string, Record<number, string[]>>
}

export type MigrationEntityStatusV2 = 'migrated' | 'preserved' | 'rejected' | 'deduplicated'
export type MigrationEntityResultV2 = {
  entityId: string
  status: MigrationEntityStatusV2
  code?: string
  legacyId?: string
  shadowPlanId?: string
}

export type LegacyWorkoutInputV1 = {
  activePlan?: unknown | null
  savedPlans?: unknown[] | null
  sessions?: unknown[] | null
  lastSession?: unknown | null
  selectedVoiceId?: unknown
}

export type MigrationPreviewV2 = {
  state: LocalWorkoutStateV2
  entities: MigrationEntityResultV2[]
  issues: PreflightIssueV2[]
}

const FIXED_RECORD_TIME = '2026-07-29T00:00:00.000Z'
const COUNT_BANK_ID = 'count-low-1-40'
const COUNT_BANK_REVISION = '2'
const FIXED_EXERCISE_REVISION = 'fixed-v2/1'

function countAudioBank() {
  return Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
    const value = index + 1
    const padded = String(value).padStart(2, '0')
    return [value, [`/media/audio/count-low-${padded}.wav`, `/media/audio/count-low-${padded}-v2.wav`]]
  }))
}

function motion(videoName: string, posterName = `${videoName}-poster.png`) {
  return {
    // Keep the authored MP4 master as the primary source for iPhone Safari;
    // WebM remains an explicit fallback. The app never re-encodes either file.
    videoUri: `/media/actions/videos/${videoName}.mp4`,
    videoFallbackUri: `/media/actions/videos/${videoName}.webm`,
    posterUri: `/media/actions/posters/${posterName}`,
  }
}

export const DEFAULT_WORKOUT_RESOURCE_CATALOG_V2: WorkoutResourceCatalogV2 = {
  exercises: {
    'goblet-squat': { revision: FIXED_EXERCISE_REVISION, motionAssets: { 'goblet-squat.v1@1': { ...motion('goblet-squat'), posterUri: '/media/actions/posters/goblet-squat-poster.png' } } },
    'romanian-deadlift': { revision: FIXED_EXERCISE_REVISION, motionAssets: { 'romanian-deadlift.v1@1': motion('romanian-deadlift', 'dumbbell-romanian-deadlift-poster.png') } },
    'reverse-lunge': { revision: FIXED_EXERCISE_REVISION, motionAssets: { 'reverse-lunge.v1@1': motion('reverse-lunge') } },
    'glute-bridge': { revision: FIXED_EXERCISE_REVISION, motionAssets: { 'glute-bridge.v1@1': motion('glute-bridge', 'dumbbell-glute-bridge-poster.png') } },
    'bodyweight-squat': { revision: 'personal-rule-v2/1', motionAssets: { 'bodyweight-squat.v1@1': motion('bodyweight-squat') } },
    'forearm-plank': { revision: 'personal-rule-v2/1', motionAssets: { 'forearm-plank.v1@1': motion('forearm-plank') } },
    'dumbbell-biceps-curl': { revision: 'personal-rule-v2/1', motionAssets: { 'dumbbell-biceps-curl.v1@1': motion('dumbbell-biceps-curl') } },
  },
  countAudioBanks: { [`${COUNT_BANK_ID}@${COUNT_BANK_REVISION}`]: countAudioBank() },
}

const fixedCounting: Record<string, CountingSpecV2> = {
  'goblet-squat': { mode: 'repetition', targetCount: 10, cycleDurationMs: 4_500, segmentDurationMs: 45_000 },
  'romanian-deadlift': { mode: 'repetition', targetCount: 10, cycleDurationMs: 4_500, segmentDurationMs: 45_000 },
  'reverse-lunge': { mode: 'alternating_pair', targetPerSide: 8, startingSide: 'left', cycleDurationMs: 6_000, segmentDurationMs: 48_000 },
  'glute-bridge': { mode: 'repetition', targetCount: 12, cycleDurationMs: 3_000, segmentDurationMs: 36_000 },
}

const fixedMotionIds: Record<string, string> = {
  'goblet-squat': 'goblet-squat.v1',
  'romanian-deadlift': 'romanian-deadlift.v1',
  'reverse-lunge': 'reverse-lunge.v1',
  'glute-bridge': 'glute-bridge.v1',
}

export const LEGACY_EXERCISE_MIGRATION_RULES_V2: Record<string, LegacyExerciseMigrationRuleV2> = {
  ...Object.fromEntries(Object.keys(fixedCounting).map((exerciseId) => [exerciseId, {
    legacyExerciseId: exerciseId,
    ruleRevision: 'legacy-exercise-rule-v2/1',
    exerciseRevision: FIXED_EXERCISE_REVISION,
    counting: fixedCounting[exerciseId],
    motionAssetRef: { assetId: fixedMotionIds[exerciseId], revision: '1' },
  }])),
  'bodyweight-squat': {
    legacyExerciseId: 'bodyweight-squat', ruleRevision: 'legacy-exercise-rule-v2/1', exerciseRevision: 'personal-rule-v2/1',
    counting: { mode: 'repetition', targetCount: 12, cycleDurationMs: 3_000, segmentDurationMs: 36_000 },
    motionAssetRef: { assetId: 'bodyweight-squat.v1', revision: '1' },
  },
  'forearm-plank': {
    legacyExerciseId: 'forearm-plank', ruleRevision: 'legacy-exercise-rule-v2/1', exerciseRevision: 'personal-rule-v2/1',
    counting: { mode: 'timed', targetSeconds: 30, segmentDurationMs: 30_000, countdownCueSeconds: [10, 5, 4, 3, 2, 1] },
    motionAssetRef: { assetId: 'forearm-plank.v1', revision: '1' },
  },
  'dumbbell-biceps-curl': {
    legacyExerciseId: 'dumbbell-biceps-curl', ruleRevision: 'legacy-exercise-rule-v2/1', exerciseRevision: 'personal-rule-v2/1',
    counting: { mode: 'alternating_pair', targetPerSide: 12, startingSide: 'left', cycleDurationMs: 4_000, segmentDurationMs: 48_000 },
    motionAssetRef: { assetId: 'dumbbell-biceps-curl.v1', revision: '1' },
  },
}

export function createFixedWorkoutPlanRecordV2(): WorkoutPlanRecordV2 {
  return {
    schemaVersion: 2,
    id: FIXED_RUNTIME_PLAN_ID,
    version: 2,
    revision: 'fixed-runtime-v2/1',
    title: guidedWorkoutPlanV2.title,
    subtitle: '4 个核心动作 · 3 轮 · 完整跟练约 14:20。',
    source: 'system',
    executionPolicy: 'fixed_entry',
    displayDurationMinutes: guidedWorkoutPlanV2.displayDurationMinutes,
    plannedDurationMs: guidedWorkoutPlanV2.plannedDurationMs,
    allowedDeviationMs: guidedWorkoutPlanV2.allowedDeviationMs,
    preparationMs: guidedWorkoutPlanV2.preparationMs,
    transitionRestMs: guidedWorkoutPlanV2.transitionRestMs,
    roundRestMs: guidedWorkoutPlanV2.roundRestMs,
    cooldownMs: guidedWorkoutPlanV2.cooldownMs,
    rounds: guidedWorkoutPlanV2.rounds,
    estimatedCalories: 96,
    countAudioBankRef: { bankId: COUNT_BANK_ID, revision: COUNT_BANK_REVISION },
    exercises: guidedWorkoutPlanV2.exercises.map((exercise, position) => ({
      position,
      exerciseId: exercise.exerciseId,
      exerciseRevision: FIXED_EXERCISE_REVISION,
      counting: fixedCounting[exercise.exerciseId],
      motionAssetRef: { assetId: fixedMotionIds[exercise.exerciseId], revision: '1' },
    })),
    createdAt: FIXED_RECORD_TIME,
    updatedAt: FIXED_RECORD_TIME,
  }
}

function repetitionTimeline(targetCount: number, cycleDurationMs: number) {
  return Array.from({ length: targetCount }, (_, index) => ({ id: `rep-${index + 1}`, atMs: (index + 1) * cycleDurationMs, type: 'rep_complete' as const, value: index + 1 }))
}

function alternatingTimeline(targetPerSide: number, cycleDurationMs: number, startingSide: 'left' | 'right') {
  const first = startingSide === 'left' ? 'left_complete' as const : 'right_complete' as const
  const second = startingSide === 'left' ? 'right_complete' as const : 'left_complete' as const
  return Array.from({ length: targetPerSide }, (_, index) => {
    const value = index + 1
    return [
      { id: `${first}-${value}`, atMs: index * cycleDurationMs + cycleDurationMs / 2, type: first, value },
      { id: `${second}-${value}`, atMs: (index + 1) * cycleDurationMs, type: second, value },
      { id: `pair-${value}`, atMs: (index + 1) * cycleDurationMs, type: 'pair_complete' as const, value },
    ]
  }).flat()
}

export function materializeWorkoutPlanV2(
  record: WorkoutPlanRecordV2,
  catalog = DEFAULT_WORKOUT_RESOURCE_CATALOG_V2,
  purpose: 'fixed_runtime' | 'headless_preflight' = 'fixed_runtime',
): WorkoutPlanV2 {
  const validation = validateWorkoutPlanRecordV2(record)
  if (!validation.ok) throw new WorkoutP1Error(validation.issues.some((entry) => entry.code === 'PLAN_DURATION_MISMATCH') ? 'PLAN_DURATION_MISMATCH' : 'PLAN_SCHEMA_INVALID', 'plan record is invalid', validation.issues)
  if (record.executionPolicy === 'save_only' && purpose !== 'headless_preflight') throw new WorkoutP1Error('PLAN_PERSONAL_RUNTIME_FORBIDDEN', 'personal plans cannot be materialized for runtime')
  const bank = catalog.countAudioBanks[`${record.countAudioBankRef.bankId}@${record.countAudioBankRef.revision}`]
  if (!bank) throw new WorkoutP1Error('PLAN_REFERENCE_MISSING', 'count audio bank revision is missing')
  const exercises: WorkoutExerciseV2[] = record.exercises.map((entry) => {
    const exerciseResource = catalog.exercises[entry.exerciseId]
    const motionResource = exerciseResource?.motionAssets[`${entry.motionAssetRef.assetId}@${entry.motionAssetRef.revision}`]
    if (!exerciseResource || exerciseResource.revision !== entry.exerciseRevision || !motionResource) throw new WorkoutP1Error('PLAN_REFERENCE_MISSING', `resource revision missing for ${entry.exerciseId}`)
    const narration = entry.detailNarrationRef ? exerciseResource.detailNarrations?.[`${entry.detailNarrationRef.assetId}@${entry.detailNarrationRef.revision}`] : undefined
    if (entry.detailNarrationRef && !narration) throw new WorkoutP1Error('PLAN_REFERENCE_MISSING', `narration revision missing for ${entry.exerciseId}`)
    const common = {
      exerciseId: entry.exerciseId,
      segmentDurationMs: entry.counting.segmentDurationMs,
      videoUri: motionResource.videoUri,
      videoFallbackUri: motionResource.videoFallbackUri,
      posterUri: motionResource.posterUri,
      countAudioVariants: bank,
      ...(narration ? { detailNarrationUri: narration.uri, detailNarrationDurationMs: narration.durationMs } : {}),
    }
    if (entry.counting.mode === 'repetition') return { ...common, countingMode: 'repetition', targetCount: entry.counting.targetCount, cycleDurationMs: entry.counting.cycleDurationMs, timelineEvents: repetitionTimeline(entry.counting.targetCount, entry.counting.cycleDurationMs) }
    if (entry.counting.mode === 'alternating_pair') return { ...common, countingMode: 'alternating_pair', targetPerSide: entry.counting.targetPerSide, startingSide: entry.counting.startingSide, cycleDurationMs: entry.counting.cycleDurationMs, timelineEvents: alternatingTimeline(entry.counting.targetPerSide, entry.counting.cycleDurationMs, entry.counting.startingSide) }
    return { ...common, countingMode: 'timed', targetSeconds: entry.counting.targetSeconds, countdownCueSeconds: [...entry.counting.countdownCueSeconds], timelineEvents: buildCountdownTimeline(entry.counting.segmentDurationMs, entry.counting.countdownCueSeconds, `timed-${entry.exerciseId}`) }
  })
  return {
    id: record.id,
    version: 2,
    title: record.title,
    displayDurationMinutes: record.displayDurationMinutes,
    plannedDurationMs: record.plannedDurationMs,
    allowedDeviationMs: record.allowedDeviationMs,
    preparationMs: record.preparationMs,
    transitionRestMs: record.transitionRestMs,
    roundRestMs: record.roundRestMs,
    cooldownMs: record.cooldownMs,
    rounds: record.rounds,
    exercises,
  }
}

const supportedPresetIds = new Set([
  'quick-lower-body-v0-1', 'bodyweight-home-v0-1', 'chair-friendly-v0-1', 'dumbbell-lower-body-v0-1',
  'upper-core-foundation-v0-1', 'core-shredder-foundation-v0-1', 'full-body-foundation-v0-1',
])

function isLegacyPlan(value: unknown): value is TrainingPlan {
  if (typeof value !== 'object' || value === null) return false
  const plan = value as Partial<TrainingPlan>
  return typeof plan.id === 'string' && plan.id.trim().length > 0 && plan.id === plan.id.trim()
    && typeof plan.title === 'string' && plan.title.trim().length > 0
    && typeof plan.subtitle === 'string'
    && Number.isInteger(plan.duration) && Number(plan.duration) > 0
    && Number.isInteger(plan.rounds) && Number(plan.rounds) > 0
    && typeof plan.estimatedCalories === 'number' && Number.isFinite(plan.estimatedCalories) && plan.estimatedCalories >= 0
    && (plan.source === 'preset' || plan.source === 'personal')
    && Array.isArray(plan.exercises)
    && plan.exercises.every(isLegacyExercise)
}

function isLegacyExercise(value: unknown) {
  if (typeof value !== 'object' || value === null) return false
  const exercise = value as Record<string, unknown>
  const strings = ['id', 'name', 'duration', 'target', 'cue', 'breathing', 'videoLabel']
  const stringArrays = ['tips', 'steps', 'reminders']
  const media = exercise.media
  return strings.every((field) => typeof exercise[field] === 'string' && String(exercise[field]).trim().length > 0)
    && exercise.id === String(exercise.id).trim()
    && ['徒手', '椅子辅助', '哑铃'].includes(String(exercise.equipment))
    && Number.isSafeInteger(exercise.reps) && Number(exercise.reps) > 0
    && ['coral', 'plum', 'gold'].includes(String(exercise.targetTone))
    && exercise.videoStatus === 'approved'
    && stringArrays.every((field) => Array.isArray(exercise[field]) && (exercise[field] as unknown[]).every((item) => typeof item === 'string'))
    && (exercise.muscleGroups === undefined || (Array.isArray(exercise.muscleGroups) && exercise.muscleGroups.every((item) => typeof item === 'string')))
    && typeof media === 'object' && media !== null
    && (media as Record<string, unknown>).videoStatus === 'approved'
    && Array.isArray((media as Record<string, unknown>).voiceChoices)
}

function dedupeEnvelope(target: LegacyEnvelopeV1[], envelope: LegacyEnvelopeV1) {
  if (!target.some((entry) => entry.legacyId === envelope.legacyId)) target.push(envelope)
}

function migratePersonalPlan(
  plan: TrainingPlan,
  migratedAt: string,
  existingPlans: WorkoutPlanRecordV2[],
  legacyPlans: LegacyEnvelopeV1[],
  source: LegacyEnvelopeV1['source'],
): { result: MigrationEntityResultV2; plan?: WorkoutPlanRecordV2 } {
  const envelope = createLegacyEnvelopeV1('training-plan', plan, source)
  dedupeEnvelope(legacyPlans, envelope)
  const fingerprint = envelope.sourceFingerprintSha256
  const existing = existingPlans.find((entry) => entry.id === plan.id)
  if (existing?.migration?.sourceFingerprintSha256 === fingerprint) return { result: { entityId: plan.id, status: 'deduplicated', legacyId: envelope.legacyId, shadowPlanId: existing.id } }
  if (existing) return { result: { entityId: plan.id, status: 'rejected', code: 'MIGRATION_ID_CONFLICT', legacyId: envelope.legacyId } }
  const rules = plan.exercises.map((exercise) => LEGACY_EXERCISE_MIGRATION_RULES_V2[exercise.id])
  if (rules.some((rule) => !rule)) return { result: { entityId: plan.id, status: 'rejected', code: 'MIGRATION_RULE_MISSING', legacyId: envelope.legacyId } }
  const shadow: WorkoutPlanRecordV2 = {
    schemaVersion: 2,
    id: plan.id,
    version: 2,
    revision: `legacy-shadow/${fingerprint.slice(0, 16)}`,
    title: plan.title,
    subtitle: plan.subtitle,
    source: 'personal',
    executionPolicy: 'save_only',
    displayDurationMinutes: plan.duration,
    plannedDurationMs: 0,
    allowedDeviationMs: 30_000,
    preparationMs: 3_000,
    transitionRestMs: 20_000,
    roundRestMs: 60_000,
    cooldownMs: 60_000,
    rounds: plan.rounds,
    estimatedCalories: plan.estimatedCalories,
    countAudioBankRef: { bankId: COUNT_BANK_ID, revision: COUNT_BANK_REVISION },
    exercises: rules.map((rule, position) => ({ position, exerciseId: rule.legacyExerciseId, exerciseRevision: rule.exerciseRevision, counting: rule.counting, motionAssetRef: rule.motionAssetRef, ...(rule.detailNarrationRef ? { detailNarrationRef: rule.detailNarrationRef } : {}) })),
    createdAt: migratedAt,
    updatedAt: migratedAt,
    migration: { sourceSchemaVersion: 1, sourceId: plan.id, sourceFingerprintSha256: fingerprint, migratedAt },
  }
  shadow.plannedDurationMs = calculatePlanRecordDurationMs(shadow)
  const validation = validateWorkoutPlanRecordV2(shadow)
  if (!validation.ok) return { result: { entityId: plan.id, status: 'rejected', code: validation.issues.some((entry) => entry.code === 'PLAN_DURATION_MISMATCH') ? 'PLAN_DURATION_MISMATCH' : 'PLAN_SCHEMA_INVALID', legacyId: envelope.legacyId } }
  return { result: { entityId: plan.id, status: 'migrated', legacyId: envelope.legacyId, shadowPlanId: shadow.id }, plan: shadow }
}

function migrateOnePlan(
  value: unknown,
  migratedAt: string,
  plans: WorkoutPlanRecordV2[],
  legacyPlans: LegacyEnvelopeV1[],
  source: LegacyEnvelopeV1['source'],
): MigrationEntityResultV2 {
  if (!isLegacyPlan(value)) {
    try {
      const invalidEnvelope = createLegacyEnvelopeV1('training-plan', value, source)
      dedupeEnvelope(legacyPlans, invalidEnvelope)
      return { entityId: invalidEnvelope.legacyId, status: 'rejected', code: 'PLAN_SCHEMA_INVALID', legacyId: invalidEnvelope.legacyId }
    } catch {
      return { entityId: 'invalid-plan', status: 'rejected', code: 'PLAN_SCHEMA_INVALID' }
    }
  }
  const envelope = createLegacyEnvelopeV1('training-plan', value, source)
  dedupeEnvelope(legacyPlans, envelope)
  if (value.source === 'personal') {
    const migrated = migratePersonalPlan(value, migratedAt, plans, legacyPlans, source)
    if (migrated.plan) plans.push(migrated.plan)
    return migrated.result
  }
  if (value.id === 'lower-body-foundation-v0-2' || value.id === FIXED_RUNTIME_PLAN_ID) {
    if (value.rounds !== 3 || value.exercises.map((exercise) => exercise.id).join(',') !== 'goblet-squat,romanian-deadlift,reverse-lunge,glute-bridge') return { entityId: value.id, status: 'rejected', code: 'PLAN_SCHEMA_INVALID', legacyId: envelope.legacyId }
    return { entityId: value.id, status: 'migrated', legacyId: envelope.legacyId, shadowPlanId: FIXED_RUNTIME_PLAN_ID }
  }
  if (supportedPresetIds.has(value.id)) return { entityId: value.id, status: 'preserved', code: 'unsupported_system_preset', legacyId: envelope.legacyId }
  return { entityId: value.id, status: 'rejected', code: 'unknown_system_preset', legacyId: envelope.legacyId }
}

function isP0CompletionRecord(value: unknown) {
  return typeof value === 'object' && value !== null && typeof (value as { sessionId?: unknown }).sessionId === 'string' && typeof (value as { completionEventId?: unknown }).completionEventId === 'string'
}

function isLegacySession(value: unknown): value is CompletedSession {
  if (typeof value !== 'object' || value === null) return false
  const session = value as Partial<CompletedSession>
  return isIsoUtc(session.completedAt)
    && Number.isSafeInteger(session.rounds) && Number(session.rounds) >= 0
    && Number.isSafeInteger(session.skipped) && Number(session.skipped) >= 0
    && typeof session.estimatedCalories === 'number' && Number.isFinite(session.estimatedCalories) && session.estimatedCalories >= 0
}

export function createFreshLocalWorkoutStateV2(completedAt: string, selectedVoiceId: string | null = null): LocalWorkoutStateV2 {
  const state: LocalWorkoutStateV2 = {
    schemaVersion: 2,
    contractVersion: WORKOUT_P1_CONTRACT_VERSION,
    fixedRuntimePlanId: FIXED_RUNTIME_PLAN_ID,
    editorSelectedPlanId: FIXED_RUNTIME_PLAN_ID,
    plans: [createFixedWorkoutPlanRecordV2()],
    legacyPlans: [],
    sessions: [],
    legacySessions: [],
    lastSessionRef: null,
    selectedVoiceId,
    migration: { source: 'fresh', completedAt },
  }
  const validation = validateLocalWorkoutStateV2(state)
  if (!validation.ok) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'fresh workout root is invalid', validation.issues)
  return validation.value
}

export function migrateLegacyWorkoutDataV2(
  input: LegacyWorkoutInputV1,
  options: { source: 'legacy-local' | 'backup-v1'; migratedAt: string; knownVoiceIds: readonly string[] },
): MigrationPreviewV2 {
  const plans = [createFixedWorkoutPlanRecordV2()]
  const legacyPlans: LegacyEnvelopeV1[] = []
  const legacySessions: LegacyEnvelopeV1[] = []
  const entities: MigrationEntityResultV2[] = []
  const issues: PreflightIssueV2[] = []
  const source = options.source === 'backup-v1' ? 'backup-v1' as const : 'local-storage' as const
  const allPlans = [...(Array.isArray(input.savedPlans) ? input.savedPlans : [])]
  if (input.activePlan !== undefined && input.activePlan !== null && !allPlans.some((plan) => {
    try { return canonicalJson(plan) === canonicalJson(input.activePlan) } catch { return false }
  })) allPlans.push(input.activePlan)
  for (const plan of allPlans) entities.push(migrateOnePlan(plan, options.migratedAt, plans, legacyPlans, source))

  const sessionValues = [...(Array.isArray(input.sessions) ? input.sessions : [])]
  if (input.lastSession !== undefined && input.lastSession !== null && !sessionValues.some((session) => {
    try { return canonicalJson(session) === canonicalJson(input.lastSession) } catch { return false }
  })) sessionValues.push(input.lastSession)
  let lastLegacyId: string | null = null
  for (const session of sessionValues) {
    if (!isLegacySession(session)) {
      try {
        const invalidEnvelope = createLegacyEnvelopeV1('completed-session', session, source)
        dedupeEnvelope(legacySessions, invalidEnvelope)
        entities.push({ entityId: invalidEnvelope.legacyId, status: 'rejected', code: 'BACKUP_SCHEMA_INVALID', legacyId: invalidEnvelope.legacyId })
      } catch {
        entities.push({ entityId: 'invalid-session', status: 'rejected', code: 'BACKUP_SCHEMA_INVALID' })
      }
      continue
    }
    const kind = isP0CompletionRecord(session) ? 'workout-completion-record-p0' as const : 'completed-session' as const
    const envelope = createLegacyEnvelopeV1(kind, session, source)
    const before = legacySessions.length
    dedupeEnvelope(legacySessions, envelope)
    entities.push({ entityId: envelope.legacyId, status: before === legacySessions.length ? 'deduplicated' : 'preserved', legacyId: envelope.legacyId })
    if (input.lastSession !== undefined && input.lastSession !== null && canonicalJson(session) === canonicalJson(input.lastSession)) lastLegacyId = envelope.legacyId
  }

  let selectedVoiceId: string | null = null
  if (typeof input.selectedVoiceId === 'string' && options.knownVoiceIds.includes(input.selectedVoiceId)) selectedVoiceId = input.selectedVoiceId
  else if (input.selectedVoiceId !== undefined && input.selectedVoiceId !== null) issues.push({ code: 'UNKNOWN_VOICE_ID', severity: 'warning', path: '$.selectedVoiceId', message: 'unknown voice selection was ignored' })

  let editorSelectedPlanId: string | null = FIXED_RUNTIME_PLAN_ID
  const activePlan = input.activePlan
  if (isLegacyPlan(activePlan)) {
    const result = entities.find((entry) => entry.entityId === activePlan.id)
    editorSelectedPlanId = result?.shadowPlanId ?? result?.legacyId ?? FIXED_RUNTIME_PLAN_ID
  }
  const state = canonicalizeLocalWorkoutStateV2({
    schemaVersion: 2,
    contractVersion: WORKOUT_P1_CONTRACT_VERSION,
    fixedRuntimePlanId: FIXED_RUNTIME_PLAN_ID,
    editorSelectedPlanId,
    plans,
    legacyPlans,
    sessions: [],
    legacySessions,
    lastSessionRef: lastLegacyId ? { kind: 'legacy', legacyId: lastLegacyId } : null,
    selectedVoiceId,
    migration: { source: options.source, completedAt: options.migratedAt },
  })
  const validation = validateLocalWorkoutStateV2(state)
  if (!validation.ok) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'legacy migration produced an invalid root', validation.issues)
  return { state: validation.value, entities, issues }
}

export function fixedPlanSourceFingerprint() {
  return legacyFingerprint(createFixedWorkoutPlanRecordV2())
}

export function refreshWorkoutPlanStateV2(
  current: LocalWorkoutStateV2,
  input: Pick<LegacyWorkoutInputV1, 'activePlan' | 'savedPlans' | 'selectedVoiceId'>,
  options: { migratedAt: string; knownVoiceIds: readonly string[] },
): MigrationPreviewV2 {
  const currentValidation = validateLocalWorkoutStateV2(current)
  if (!currentValidation.ok) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'cannot refresh an invalid workout root', currentValidation.issues)
  const preview = migrateLegacyWorkoutDataV2(input, { source: 'legacy-local', migratedAt: options.migratedAt, knownVoiceIds: options.knownVoiceIds })
  const legacyPlans = [...currentValidation.value.legacyPlans]
  preview.state.legacyPlans.forEach((entry) => dedupeEnvelope(legacyPlans, entry))
  const state = canonicalizeLocalWorkoutStateV2({
    ...currentValidation.value,
    editorSelectedPlanId: preview.state.editorSelectedPlanId,
    plans: preview.state.plans,
    legacyPlans,
    selectedVoiceId: preview.state.selectedVoiceId,
  })
  const validation = validateLocalWorkoutStateV2(state)
  if (!validation.ok) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'plan refresh produced an invalid workout root', validation.issues)
  return { state: validation.value, entities: preview.entities, issues: preview.issues }
}
