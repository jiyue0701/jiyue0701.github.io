export const WORKOUT_P1_CONTRACT_VERSION = 'workout-p1-architecture-contract/1' as const
export const FIXED_RUNTIME_PLAN_ID = 'lower-body-guided-15m-v2' as const
export const WORKOUT_DATA_V2_KEY = 'workout-data-v2' as const
export const WORKOUT_BACKUP_FORMAT = 'wriothesley-training-backup' as const

export type WorkoutP1ErrorCode =
  | 'SESSION_NOT_COMPLETED'
  | 'SESSION_CONFLICT'
  | 'SESSION_SEGMENT_SET_INVALID'
  | 'PLAN_SCHEMA_INVALID'
  | 'PLAN_DURATION_MISMATCH'
  | 'PLAN_REFERENCE_MISSING'
  | 'PLAN_PERSONAL_RUNTIME_FORBIDDEN'
  | 'MIGRATION_RULE_MISSING'
  | 'MIGRATION_ID_CONFLICT'
  | 'BACKUP_INVALID_JSON'
  | 'BACKUP_FORMAT_MISMATCH'
  | 'BACKUP_UNSUPPORTED_VERSION'
  | 'BACKUP_SCHEMA_INVALID'
  | 'BACKUP_PERSIST_FAILED'

export type PreflightIssueV2 = {
  code: string
  severity: 'error' | 'warning'
  path: string
  entityId?: string
  message: string
}

export type ValidationResultV2<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: PreflightIssueV2[] }

export class WorkoutP1Error extends Error {
  readonly code: WorkoutP1ErrorCode
  readonly issues: PreflightIssueV2[]

  constructor(code: WorkoutP1ErrorCode, message: string, issues: PreflightIssueV2[] = []) {
    super(message)
    this.name = 'WorkoutP1Error'
    this.code = code
    this.issues = issues.length ? issues : [{ code, severity: 'error', path: '$', message }]
  }
}

export type CountingMode = 'repetition' | 'timed' | 'alternating_pair'
export type StartingSide = 'left' | 'right'

export type TimelineEvent = {
  id: string
  atMs: number
  type: 'rep_complete' | 'left_complete' | 'right_complete' | 'pair_complete' | 'countdown_number'
  value?: number
}

export type WorkoutExerciseV2 = {
  exerciseId: string
  countingMode: CountingMode
  targetCount?: number
  targetSeconds?: number
  targetPerSide?: number
  startingSide?: StartingSide
  cycleDurationMs?: number
  segmentDurationMs: number
  timelineEvents: TimelineEvent[]
  countdownCueSeconds?: number[]
  videoUri: string
  videoFallbackUri?: string
  posterUri: string
  countAudioVariants: Record<number, string[]>
  detailNarrationUri?: string
  detailNarrationDurationMs?: number
}

export type WorkoutPlanV2 = {
  id: string
  version: 2
  title: string
  displayDurationMinutes: number
  plannedDurationMs: number
  allowedDeviationMs: number
  preparationMs: number
  transitionRestMs: number
  roundRestMs: number
  cooldownMs: number
  rounds: number
  exercises: WorkoutExerciseV2[]
}

export type CountingSpecV2 =
  | { mode: 'repetition'; targetCount: number; cycleDurationMs: number; segmentDurationMs: number }
  | { mode: 'timed'; targetSeconds: number; segmentDurationMs: number; countdownCueSeconds: number[] }
  | { mode: 'alternating_pair'; targetPerSide: number; startingSide: StartingSide; cycleDurationMs: number; segmentDurationMs: number }

export type WorkoutPlanExerciseRecordV2 = {
  position: number
  exerciseId: string
  exerciseRevision: string
  counting: CountingSpecV2
  motionAssetRef: { assetId: string; revision: string }
  detailNarrationRef?: { assetId: string; revision: string }
}

export type WorkoutPlanRecordV2 = {
  schemaVersion: 2
  id: string
  version: 2
  revision: string
  title: string
  subtitle: string
  source: 'system' | 'personal'
  executionPolicy: 'fixed_entry' | 'save_only'
  displayDurationMinutes: number
  plannedDurationMs: number
  allowedDeviationMs: number
  preparationMs: number
  transitionRestMs: number
  roundRestMs: number
  cooldownMs: number
  rounds: number
  estimatedCalories: number
  countAudioBankRef: { bankId: string; revision: string }
  exercises: WorkoutPlanExerciseRecordV2[]
  createdAt: string
  updatedAt: string
  migration?: {
    sourceSchemaVersion: 1
    sourceId: string
    sourceFingerprintSha256: string
    migratedAt: string
  }
}

export type CompletedSessionV2 = {
  schemaVersion: 2
  sessionId: string
  planId: string
  planVersion: 2
  completionEventId: string
  completedAt: string
  plannedDurationMs: number
  activeElapsedMs: number
  wallElapsedMs: number
  completedSegmentIds: string[]
  skippedSegmentIds: string[]
  roundsCompleted: number
  summary: { planTitle: string; exerciseCount: number; estimatedCalories: number }
}

export type LegacyEnvelopeKindV1 = 'training-plan' | 'completed-session' | 'workout-completion-record-p0'
export type LegacyEnvelopeV1<T = unknown> = {
  legacySchemaVersion: 1
  legacyId: string
  source: 'local-storage' | 'backup-v1'
  kind: LegacyEnvelopeKindV1
  sourceFingerprintSha256: string
  data: T
}

export type SessionRefV2 = { kind: 'v2'; sessionId: string } | { kind: 'legacy'; legacyId: string }

export type LocalWorkoutStateV2 = {
  schemaVersion: 2
  contractVersion: typeof WORKOUT_P1_CONTRACT_VERSION
  fixedRuntimePlanId: typeof FIXED_RUNTIME_PLAN_ID
  editorSelectedPlanId: string | null
  plans: WorkoutPlanRecordV2[]
  legacyPlans: LegacyEnvelopeV1[]
  sessions: CompletedSessionV2[]
  legacySessions: LegacyEnvelopeV1[]
  lastSessionRef: SessionRefV2 | null
  selectedVoiceId: string | null
  migration: { source: 'fresh' | 'legacy-local' | 'backup-v1' | 'backup-v2'; completedAt: string }
}

export type WorkoutBackupV2 = {
  format: typeof WORKOUT_BACKUP_FORMAT
  version: 2
  exportedAt: string
  payload: LocalWorkoutStateV2
}

export type WorkoutDataPreflightV2 = {
  contractVersion: typeof WORKOUT_P1_CONTRACT_VERSION
  schemaValid: boolean
  migrationValid: boolean
  backupRoundTripValid: boolean
  fixedRuntimePlanId: typeof FIXED_RUNTIME_PLAN_ID
  fixedRuntimeReady: boolean
  personalPlanDataReadyIds: string[]
  personalPlanRuntimeEnabled: false
  issues: PreflightIssueV2[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isIdentifier(value: unknown): value is string {
  return isNonEmptyString(value) && value === value.trim()
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isIsoUtc(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value))
}

function issue(code: string, path: string, message: string, entityId?: string): PreflightIssueV2 {
  return { code, severity: 'error', path, message, ...(entityId ? { entityId } : {}) }
}

function rejectUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, code: string, issues: PreflightIssueV2[]) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extras.length) issues.push(issue(code, path, `unexpected fields: ${extras.join(', ')}`))
}

function uniqueStrings(values: unknown): values is string[] {
  return Array.isArray(values) && values.every(isIdentifier) && new Set(values).size === values.length
}

function validatePureJson(value: unknown, path = '$', seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path}: number must be finite`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${path}: value is not JSON serializable`)
  if (seen.has(value)) throw new Error(`${path}: circular reference`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePureJson(item, `${path}[${index}]`, seen))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path}: object must be plain JSON data`)
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) throw new Error(`${path}.${key}: undefined is not JSON serializable`)
      validatePureJson(item, `${path}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
}

export function canonicalJson(value: unknown) {
  validatePureJson(value)
  return JSON.stringify(canonicalValue(value))
}

// Small synchronous SHA-256 implementation keeps migration previews deterministic in browsers and tests.
export function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value)
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const data = new Uint8Array(paddedLength)
  data.set(bytes)
  data[bytes.length] = 0x80
  const view = new DataView(data.buffer)
  view.setUint32(paddedLength - 4, bitLength >>> 0)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000))
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  let hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const rotate = (number: number, bits: number) => (number >>> bits) | (number << (32 - bits))
  for (let offset = 0; offset < data.length; offset += 64) {
    const words = new Uint32Array(64)
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]
      const b = words[index - 2]
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10)
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + choice + constants[index] + words[index]) >>> 0
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    hash = [
      (hash[0] + a) >>> 0, (hash[1] + b) >>> 0, (hash[2] + c) >>> 0, (hash[3] + d) >>> 0,
      (hash[4] + e) >>> 0, (hash[5] + f) >>> 0, (hash[6] + g) >>> 0, (hash[7] + h) >>> 0,
    ]
  }
  return hash.map((part) => part.toString(16).padStart(8, '0')).join('')
}

export function legacyFingerprint(data: unknown) {
  return sha256Hex(canonicalJson(data))
}

export function legacyId(kind: LegacyEnvelopeKindV1, data: unknown) {
  return `${kind}/${sha256Hex(`${kind}:${canonicalJson(data)}`)}`
}

export function createLegacyEnvelopeV1<T>(kind: LegacyEnvelopeKindV1, data: T, source: LegacyEnvelopeV1['source']): LegacyEnvelopeV1<T> {
  canonicalJson(data)
  return { legacySchemaVersion: 1, legacyId: legacyId(kind, data), source, kind, sourceFingerprintSha256: legacyFingerprint(data), data }
}

export function calculatePlanRecordDurationMs(plan: Pick<WorkoutPlanRecordV2, 'preparationMs' | 'transitionRestMs' | 'roundRestMs' | 'cooldownMs' | 'rounds' | 'exercises'>) {
  const activePerRound = plan.exercises.reduce((sum, exercise) => sum + exercise.counting.segmentDurationMs, 0)
  const transitionsPerRound = Math.max(0, plan.exercises.length - 1) * plan.transitionRestMs
  return plan.preparationMs + plan.rounds * (activePerRound + transitionsPerRound) + Math.max(0, plan.rounds - 1) * plan.roundRestMs + plan.cooldownMs
}

export function planRecordSegmentIds(plan: Pick<WorkoutPlanRecordV2, 'preparationMs' | 'transitionRestMs' | 'roundRestMs' | 'cooldownMs' | 'rounds' | 'exercises'>) {
  const ids: string[] = []
  if (plan.preparationMs > 0) ids.push('preparation')
  for (let roundIndex = 0; roundIndex < plan.rounds; roundIndex += 1) {
    plan.exercises.forEach((_, exerciseIndex) => {
      ids.push(`round-${roundIndex + 1}-exercise-${exerciseIndex + 1}`)
      if (exerciseIndex < plan.exercises.length - 1) ids.push(`round-${roundIndex + 1}-transition-${exerciseIndex + 1}`)
    })
    if (roundIndex < plan.rounds - 1) ids.push(`round-${roundIndex + 1}-rest`)
  }
  if (plan.cooldownMs > 0) ids.push('cooldown')
  return ids
}

function validateCountingSpec(value: unknown, path: string, issues: PreflightIssueV2[]) {
  if (!isRecord(value) || !['repetition', 'timed', 'alternating_pair'].includes(String(value.mode))) {
    issues.push(issue('PLAN_SCHEMA_INVALID', path, 'counting must be a supported discriminated union'))
    return
  }
  const allowed = value.mode === 'repetition'
    ? new Set(['mode', 'targetCount', 'cycleDurationMs', 'segmentDurationMs'])
    : value.mode === 'timed'
      ? new Set(['mode', 'targetSeconds', 'segmentDurationMs', 'countdownCueSeconds'])
      : new Set(['mode', 'targetPerSide', 'startingSide', 'cycleDurationMs', 'segmentDurationMs'])
  if (Object.keys(value).some((key) => !allowed.has(key))) issues.push(issue('PLAN_SCHEMA_INVALID', path, 'counting target fields must be mutually exclusive'))
  if (!isPositiveInteger(value.segmentDurationMs)) issues.push(issue('PLAN_SCHEMA_INVALID', `${path}.segmentDurationMs`, 'segment duration must be a positive integer'))
  if (value.mode === 'repetition') {
    if (!isPositiveInteger(value.targetCount) || !isPositiveInteger(value.cycleDurationMs)) issues.push(issue('PLAN_SCHEMA_INVALID', path, 'repetition target and cycle must be positive integers'))
    else if (value.targetCount * value.cycleDurationMs !== value.segmentDurationMs) issues.push(issue('PLAN_DURATION_MISMATCH', path, 'repetition duration does not equal targetCount * cycleDurationMs'))
  } else if (value.mode === 'timed') {
    if (!isPositiveInteger(value.targetSeconds) || value.targetSeconds * 1000 !== value.segmentDurationMs) issues.push(issue('PLAN_DURATION_MISMATCH', path, 'timed duration does not equal targetSeconds'))
    if (!uniqueStrings((value.countdownCueSeconds as unknown[] | undefined)?.map(String)) || !(value.countdownCueSeconds as unknown[]).every(isPositiveInteger)) issues.push(issue('PLAN_SCHEMA_INVALID', `${path}.countdownCueSeconds`, 'countdown seconds must be unique positive integers'))
  } else {
    if (!isPositiveInteger(value.targetPerSide) || !isPositiveInteger(value.cycleDurationMs) || !['left', 'right'].includes(String(value.startingSide))) issues.push(issue('PLAN_SCHEMA_INVALID', path, 'alternating pair fields are invalid'))
    else if (value.targetPerSide * value.cycleDurationMs !== value.segmentDurationMs) issues.push(issue('PLAN_DURATION_MISMATCH', path, 'alternating duration does not equal targetPerSide * cycleDurationMs'))
  }
}

export function validateWorkoutPlanRecordV2(value: unknown): ValidationResultV2<WorkoutPlanRecordV2> {
  const issues: PreflightIssueV2[] = []
  if (!isRecord(value)) return { ok: false, issues: [issue('PLAN_SCHEMA_INVALID', '$', 'plan must be an object')] }
  rejectUnexpectedKeys(value, ['schemaVersion', 'id', 'version', 'revision', 'title', 'subtitle', 'source', 'executionPolicy', 'displayDurationMinutes', 'plannedDurationMs', 'allowedDeviationMs', 'preparationMs', 'transitionRestMs', 'roundRestMs', 'cooldownMs', 'rounds', 'estimatedCalories', 'countAudioBankRef', 'exercises', 'createdAt', 'updatedAt', 'migration'], '$', 'PLAN_SCHEMA_INVALID', issues)
  for (const field of ['id', 'revision'] as const) if (!isIdentifier(value[field])) issues.push(issue('PLAN_SCHEMA_INVALID', `$.${field}`, `${field} must be a trimmed non-empty ID`))
  for (const field of ['title', 'subtitle'] as const) if (!isNonEmptyString(value[field])) issues.push(issue('PLAN_SCHEMA_INVALID', `$.${field}`, `${field} must be non-empty`))
  if (value.schemaVersion !== 2 || value.version !== 2) issues.push(issue('PLAN_SCHEMA_INVALID', '$.schemaVersion', 'plan schema/version must be 2'))
  if (!['system', 'personal'].includes(String(value.source)) || !['fixed_entry', 'save_only'].includes(String(value.executionPolicy))) issues.push(issue('PLAN_SCHEMA_INVALID', '$.executionPolicy', 'plan source or execution policy is invalid'))
  if (value.executionPolicy === 'fixed_entry' && value.id !== FIXED_RUNTIME_PLAN_ID) issues.push(issue('PLAN_PERSONAL_RUNTIME_FORBIDDEN', '$.executionPolicy', 'only the fixed plan may be executable', String(value.id)))
  if (value.source === 'personal' && value.executionPolicy !== 'save_only') issues.push(issue('PLAN_PERSONAL_RUNTIME_FORBIDDEN', '$.executionPolicy', 'personal plans must remain save_only', String(value.id)))
  for (const field of ['displayDurationMinutes', 'plannedDurationMs', 'rounds'] as const) if (!isPositiveInteger(value[field])) issues.push(issue('PLAN_SCHEMA_INVALID', `$.${field}`, `${field} must be a positive integer`))
  for (const field of ['allowedDeviationMs', 'preparationMs', 'transitionRestMs', 'roundRestMs', 'cooldownMs'] as const) if (!isSafeNonNegativeInteger(value[field])) issues.push(issue('PLAN_SCHEMA_INVALID', `$.${field}`, `${field} must be a non-negative integer`))
  if (typeof value.estimatedCalories !== 'number' || !Number.isFinite(value.estimatedCalories) || value.estimatedCalories < 0) issues.push(issue('PLAN_SCHEMA_INVALID', '$.estimatedCalories', 'estimatedCalories must be finite and non-negative'))
  if (!isRecord(value.countAudioBankRef) || !isIdentifier(value.countAudioBankRef.bankId) || !isIdentifier(value.countAudioBankRef.revision)) issues.push(issue('PLAN_SCHEMA_INVALID', '$.countAudioBankRef', 'audio bank reference is invalid'))
  else rejectUnexpectedKeys(value.countAudioBankRef, ['bankId', 'revision'], '$.countAudioBankRef', 'PLAN_SCHEMA_INVALID', issues)
  if (!Array.isArray(value.exercises) || !value.exercises.length) issues.push(issue('PLAN_SCHEMA_INVALID', '$.exercises', 'plan must contain exercises'))
  else value.exercises.forEach((exercise, index) => {
    const path = `$.exercises[${index}]`
    if (!isRecord(exercise)) { issues.push(issue('PLAN_SCHEMA_INVALID', path, 'exercise must be an object')); return }
    rejectUnexpectedKeys(exercise, ['position', 'exerciseId', 'exerciseRevision', 'counting', 'motionAssetRef', 'detailNarrationRef'], path, 'PLAN_SCHEMA_INVALID', issues)
    if (exercise.position !== index) issues.push(issue('PLAN_SCHEMA_INVALID', `${path}.position`, 'positions must be contiguous from zero'))
    if (!isIdentifier(exercise.exerciseId) || !isIdentifier(exercise.exerciseRevision)) issues.push(issue('PLAN_SCHEMA_INVALID', path, 'exercise identity is invalid'))
    if (!isRecord(exercise.motionAssetRef) || !isIdentifier(exercise.motionAssetRef.assetId) || !isIdentifier(exercise.motionAssetRef.revision)) issues.push(issue('PLAN_SCHEMA_INVALID', `${path}.motionAssetRef`, 'motion reference is invalid'))
    else rejectUnexpectedKeys(exercise.motionAssetRef, ['assetId', 'revision'], `${path}.motionAssetRef`, 'PLAN_SCHEMA_INVALID', issues)
    if (exercise.detailNarrationRef !== undefined && (!isRecord(exercise.detailNarrationRef) || !isIdentifier(exercise.detailNarrationRef.assetId) || !isIdentifier(exercise.detailNarrationRef.revision))) issues.push(issue('PLAN_SCHEMA_INVALID', `${path}.detailNarrationRef`, 'narration reference is invalid'))
    else if (isRecord(exercise.detailNarrationRef)) rejectUnexpectedKeys(exercise.detailNarrationRef, ['assetId', 'revision'], `${path}.detailNarrationRef`, 'PLAN_SCHEMA_INVALID', issues)
    validateCountingSpec(exercise.counting, `${path}.counting`, issues)
  })
  if (Array.isArray(value.exercises) && isPositiveInteger(value.rounds) && isSafeNonNegativeInteger(value.preparationMs) && isSafeNonNegativeInteger(value.transitionRestMs) && isSafeNonNegativeInteger(value.roundRestMs) && isSafeNonNegativeInteger(value.cooldownMs)) {
    try {
      const calculated = calculatePlanRecordDurationMs(value as unknown as WorkoutPlanRecordV2)
      if (calculated !== value.plannedDurationMs) issues.push(issue('PLAN_DURATION_MISMATCH', '$.plannedDurationMs', `expected ${calculated}, received ${String(value.plannedDurationMs)}`))
    } catch { issues.push(issue('PLAN_SCHEMA_INVALID', '$.exercises', 'plan duration cannot be calculated')) }
  }
  if (!isIsoUtc(value.createdAt) || !isIsoUtc(value.updatedAt)) issues.push(issue('PLAN_SCHEMA_INVALID', '$.createdAt', 'plan dates must be ISO UTC'))
  if (value.migration !== undefined) {
    if (!isRecord(value.migration) || value.migration.sourceSchemaVersion !== 1 || !isIdentifier(value.migration.sourceId) || !isIdentifier(value.migration.sourceFingerprintSha256) || !isIsoUtc(value.migration.migratedAt)) issues.push(issue('PLAN_SCHEMA_INVALID', '$.migration', 'migration metadata is invalid'))
    else rejectUnexpectedKeys(value.migration, ['sourceSchemaVersion', 'sourceId', 'sourceFingerprintSha256', 'migratedAt'], '$.migration', 'PLAN_SCHEMA_INVALID', issues)
  }
  try { canonicalJson(value) } catch (error) { issues.push(issue('PLAN_SCHEMA_INVALID', '$', (error as Error).message)) }
  return issues.length ? { ok: false, issues } : { ok: true, value: value as WorkoutPlanRecordV2, issues: [] }
}

function orderedSubset(values: string[], canonical: string[]) {
  let previous = -1
  return values.every((value) => {
    const index = canonical.indexOf(value)
    if (index <= previous) return false
    previous = index
    return true
  })
}

export function validateCompletedSessionV2(value: unknown, canonicalSegmentIds?: readonly string[]): ValidationResultV2<CompletedSessionV2> {
  const issues: PreflightIssueV2[] = []
  if (!isRecord(value)) return { ok: false, issues: [issue('SESSION_SEGMENT_SET_INVALID', '$', 'session must be an object')] }
  rejectUnexpectedKeys(value, ['schemaVersion', 'sessionId', 'planId', 'planVersion', 'completionEventId', 'completedAt', 'plannedDurationMs', 'activeElapsedMs', 'wallElapsedMs', 'completedSegmentIds', 'skippedSegmentIds', 'roundsCompleted', 'summary'], '$', 'SESSION_SEGMENT_SET_INVALID', issues)
  if (value.schemaVersion !== 2 || value.planVersion !== 2) issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$.schemaVersion', 'session schema/plan version must be 2'))
  if (!isIdentifier(value.sessionId) || !isIdentifier(value.planId)) issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$.sessionId', 'session and plan IDs must be trimmed and non-empty'))
  if (isIdentifier(value.sessionId) && value.completionEventId !== `${value.sessionId}/workout/completed/1`) issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$.completionEventId', 'completion ID is not stable'))
  if (!isIsoUtc(value.completedAt)) issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$.completedAt', 'completedAt must be ISO UTC'))
  for (const field of ['plannedDurationMs', 'activeElapsedMs', 'wallElapsedMs', 'roundsCompleted'] as const) if (!isSafeNonNegativeInteger(value[field])) issues.push(issue('SESSION_SEGMENT_SET_INVALID', `$.${field}`, `${field} must be a non-negative safe integer`))
  if (typeof value.activeElapsedMs === 'number' && typeof value.wallElapsedMs === 'number' && value.activeElapsedMs > value.wallElapsedMs) issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$.activeElapsedMs', 'active elapsed must not exceed wall elapsed'))
  const completedSegmentIds = value.completedSegmentIds
  const skippedSegmentIds = value.skippedSegmentIds
  if (!uniqueStrings(completedSegmentIds) || !uniqueStrings(skippedSegmentIds)) issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$.completedSegmentIds', 'segment arrays must contain unique non-empty IDs'))
  else {
    const overlap = completedSegmentIds.some((id) => skippedSegmentIds.includes(id))
    if (overlap) issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$.skippedSegmentIds', 'completed and skipped segments must be disjoint'))
    if (canonicalSegmentIds) {
      const canonical = [...canonicalSegmentIds]
      if (!orderedSubset(completedSegmentIds, canonical) || !orderedSubset(skippedSegmentIds, canonical)) issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$.completedSegmentIds', 'segment arrays must follow canonical order'))
      const union = new Set([...completedSegmentIds, ...skippedSegmentIds])
      if (union.size !== canonical.length || canonical.some((id) => !union.has(id))) issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$.completedSegmentIds', 'segment union must cover the plan exactly'))
    }
  }
  if (!isRecord(value.summary) || !isNonEmptyString(value.summary.planTitle) || !isSafeNonNegativeInteger(value.summary.exerciseCount) || typeof value.summary.estimatedCalories !== 'number' || !Number.isFinite(value.summary.estimatedCalories) || value.summary.estimatedCalories < 0) issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$.summary', 'session summary is invalid'))
  else rejectUnexpectedKeys(value.summary, ['planTitle', 'exerciseCount', 'estimatedCalories'], '$.summary', 'SESSION_SEGMENT_SET_INVALID', issues)
  try { canonicalJson(value) } catch (error) { issues.push(issue('SESSION_SEGMENT_SET_INVALID', '$', (error as Error).message)) }
  return issues.length ? { ok: false, issues } : { ok: true, value: value as CompletedSessionV2, issues: [] }
}

export function validateLegacyEnvelopeV1(value: unknown): ValidationResultV2<LegacyEnvelopeV1> {
  const issues: PreflightIssueV2[] = []
  if (!isRecord(value) || value.legacySchemaVersion !== 1 || !isIdentifier(value.legacyId) || !['local-storage', 'backup-v1'].includes(String(value.source)) || !['training-plan', 'completed-session', 'workout-completion-record-p0'].includes(String(value.kind)) || !isIdentifier(value.sourceFingerprintSha256) || !('data' in value)) {
    return { ok: false, issues: [issue('BACKUP_SCHEMA_INVALID', '$', 'legacy envelope is invalid')] }
  }
  rejectUnexpectedKeys(value, ['legacySchemaVersion', 'legacyId', 'source', 'kind', 'sourceFingerprintSha256', 'data'], '$', 'BACKUP_SCHEMA_INVALID', issues)
  try {
    const expectedFingerprint = legacyFingerprint(value.data)
    const expectedId = legacyId(value.kind as LegacyEnvelopeKindV1, value.data)
    if (value.sourceFingerprintSha256 !== expectedFingerprint || value.legacyId !== expectedId) issues.push(issue('BACKUP_SCHEMA_INVALID', '$.legacyId', 'legacy identity does not match canonical data'))
  } catch (error) { issues.push(issue('BACKUP_SCHEMA_INVALID', '$.data', (error as Error).message)) }
  return issues.length ? { ok: false, issues } : { ok: true, value: value as LegacyEnvelopeV1, issues: [] }
}

export function canonicalizeLocalWorkoutStateV2(state: LocalWorkoutStateV2): LocalWorkoutStateV2 {
  return {
    ...state,
    plans: [...state.plans].sort((a, b) => a.id.localeCompare(b.id) || a.revision.localeCompare(b.revision)),
    sessions: [...state.sessions].sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.sessionId.localeCompare(b.sessionId)),
    legacyPlans: [...state.legacyPlans].sort((a, b) => a.legacyId.localeCompare(b.legacyId)),
    legacySessions: [...state.legacySessions].sort((a, b) => a.legacyId.localeCompare(b.legacyId)),
  }
}

export function validateLocalWorkoutStateV2(value: unknown): ValidationResultV2<LocalWorkoutStateV2> {
  const issues: PreflightIssueV2[] = []
  if (!isRecord(value)) return { ok: false, issues: [issue('BACKUP_SCHEMA_INVALID', '$', 'workout root must be an object')] }
  rejectUnexpectedKeys(value, ['schemaVersion', 'contractVersion', 'fixedRuntimePlanId', 'editorSelectedPlanId', 'plans', 'legacyPlans', 'sessions', 'legacySessions', 'lastSessionRef', 'selectedVoiceId', 'migration'], '$', 'BACKUP_SCHEMA_INVALID', issues)
  if (value.schemaVersion !== 2 || value.contractVersion !== WORKOUT_P1_CONTRACT_VERSION || value.fixedRuntimePlanId !== FIXED_RUNTIME_PLAN_ID) issues.push(issue('BACKUP_SCHEMA_INVALID', '$.contractVersion', 'workout root identity is invalid'))
  if (value.editorSelectedPlanId !== null && !isIdentifier(value.editorSelectedPlanId)) issues.push(issue('BACKUP_SCHEMA_INVALID', '$.editorSelectedPlanId', 'editor selection must be null or a trimmed non-empty ID'))
  for (const field of ['plans', 'legacyPlans', 'sessions', 'legacySessions'] as const) if (!Array.isArray(value[field])) issues.push(issue('BACKUP_SCHEMA_INVALID', `$.${field}`, `${field} must be an array`))
  const plans = Array.isArray(value.plans) ? value.plans : []
  const sessions = Array.isArray(value.sessions) ? value.sessions : []
  const legacyPlans = Array.isArray(value.legacyPlans) ? value.legacyPlans : []
  const legacySessions = Array.isArray(value.legacySessions) ? value.legacySessions : []
  plans.forEach((plan, index) => validateWorkoutPlanRecordV2(plan).issues.forEach((entry) => issues.push({ ...entry, path: `$.plans[${index}]${entry.path.slice(1)}` })))
  sessions.forEach((session, index) => {
    const plan = isRecord(session) ? plans.find((candidate) => isRecord(candidate) && candidate.id === session.planId) : undefined
    if (!plan) issues.push(issue('PLAN_REFERENCE_MISSING', `$.sessions[${index}].planId`, 'session plan reference is missing'))
    const canonicalIds = plan ? planRecordSegmentIds(plan as unknown as WorkoutPlanRecordV2) : undefined
    validateCompletedSessionV2(session, canonicalIds).issues.forEach((entry) => issues.push({ ...entry, path: `$.sessions[${index}]${entry.path.slice(1)}` }))
    if (plan && isRecord(session)) {
      if (session.plannedDurationMs !== plan.plannedDurationMs || session.planVersion !== plan.version) issues.push(issue('SESSION_SEGMENT_SET_INVALID', `$.sessions[${index}].plannedDurationMs`, 'session plan snapshot does not match its plan record'))
      if (isRecord(session.summary) && Array.isArray(plan.exercises) && session.summary.exerciseCount !== plan.exercises.length) issues.push(issue('SESSION_SEGMENT_SET_INVALID', `$.sessions[${index}].summary.exerciseCount`, 'exerciseCount does not match the plan'))
      if (Array.isArray(session.completedSegmentIds) && Array.isArray(session.skippedSegmentIds) && typeof plan.rounds === 'number' && Array.isArray(plan.exercises)) {
        const completedIds = session.completedSegmentIds as string[]
        const skippedIds = session.skippedSegmentIds as string[]
        const planExercises = plan.exercises as unknown[]
        let expectedRounds = 0
        for (let roundIndex = 0; roundIndex < plan.rounds; roundIndex += 1) {
          const activeIds = planExercises.map((_exercise: unknown, exerciseIndex: number) => `round-${roundIndex + 1}-exercise-${exerciseIndex + 1}`)
          if (activeIds.every((id: string) => completedIds.includes(id)) && activeIds.every((id: string) => !skippedIds.includes(id))) expectedRounds += 1
        }
        if (session.roundsCompleted !== expectedRounds) issues.push(issue('SESSION_SEGMENT_SET_INVALID', `$.sessions[${index}].roundsCompleted`, 'roundsCompleted does not match segment facts'))
      }
    }
  })
  legacyPlans.forEach((entry, index) => validateLegacyEnvelopeV1(entry).issues.forEach((item) => issues.push({ ...item, path: `$.legacyPlans[${index}]${item.path.slice(1)}` })))
  legacySessions.forEach((entry, index) => validateLegacyEnvelopeV1(entry).issues.forEach((item) => issues.push({ ...item, path: `$.legacySessions[${index}]${item.path.slice(1)}` })))
  const duplicate = (values: string[]) => values.find((item, index) => values.indexOf(item) !== index)
  const duplicatePlan = duplicate(plans.filter(isRecord).map((plan) => `${String(plan.id)}\0${String(plan.revision)}`))
  const duplicateSession = duplicate(sessions.filter(isRecord).map((session) => String(session.sessionId)))
  const duplicateLegacy = duplicate([...legacyPlans, ...legacySessions].filter(isRecord).map((entry) => String(entry.legacyId)))
  if (duplicatePlan) issues.push(issue('MIGRATION_ID_CONFLICT', '$.plans', 'duplicate plan id/revision'))
  if (duplicateSession) issues.push(issue('SESSION_CONFLICT', '$.sessions', 'duplicate sessionId'))
  if (duplicateLegacy) issues.push(issue('MIGRATION_ID_CONFLICT', '$.legacySessions', 'duplicate legacyId'))
  if (value.editorSelectedPlanId !== null && !plans.some((plan) => isRecord(plan) && plan.id === value.editorSelectedPlanId) && !legacyPlans.some((entry) => isRecord(entry) && entry.legacyId === value.editorSelectedPlanId)) issues.push(issue('BACKUP_SCHEMA_INVALID', '$.editorSelectedPlanId', 'editor selection reference is missing'))
  const lastSessionRef = value.lastSessionRef
  if (lastSessionRef !== null) {
    if (!isRecord(lastSessionRef) || !['v2', 'legacy'].includes(String(lastSessionRef.kind))) issues.push(issue('BACKUP_SCHEMA_INVALID', '$.lastSessionRef', 'last session reference is invalid'))
    else if (lastSessionRef.kind === 'v2') {
      rejectUnexpectedKeys(lastSessionRef, ['kind', 'sessionId'], '$.lastSessionRef', 'BACKUP_SCHEMA_INVALID', issues)
      if (!isIdentifier(lastSessionRef.sessionId) || !sessions.some((session) => isRecord(session) && session.sessionId === lastSessionRef.sessionId)) issues.push(issue('BACKUP_SCHEMA_INVALID', '$.lastSessionRef', 'last V2 session reference is missing'))
    } else if (lastSessionRef.kind === 'legacy') {
      rejectUnexpectedKeys(lastSessionRef, ['kind', 'legacyId'], '$.lastSessionRef', 'BACKUP_SCHEMA_INVALID', issues)
      if (!isIdentifier(lastSessionRef.legacyId) || !legacySessions.some((entry) => isRecord(entry) && entry.legacyId === lastSessionRef.legacyId)) issues.push(issue('BACKUP_SCHEMA_INVALID', '$.lastSessionRef', 'last legacy session reference is missing'))
    }
  }
  if (value.selectedVoiceId !== null && !isIdentifier(value.selectedVoiceId)) issues.push(issue('BACKUP_SCHEMA_INVALID', '$.selectedVoiceId', 'selected voice must be null or a trimmed non-empty ID'))
  if (!isRecord(value.migration) || !['fresh', 'legacy-local', 'backup-v1', 'backup-v2'].includes(String(value.migration?.source)) || !isIsoUtc(value.migration?.completedAt)) issues.push(issue('BACKUP_SCHEMA_INVALID', '$.migration', 'migration metadata is invalid'))
  else rejectUnexpectedKeys(value.migration, ['source', 'completedAt'], '$.migration', 'BACKUP_SCHEMA_INVALID', issues)
  try { canonicalJson(value) } catch (error) { issues.push(issue('BACKUP_SCHEMA_INVALID', '$', (error as Error).message)) }
  return issues.length ? { ok: false, issues } : { ok: true, value: canonicalizeLocalWorkoutStateV2(value as LocalWorkoutStateV2), issues: [] }
}

export function assertLocalWorkoutStateV2(value: unknown) {
  const result = validateLocalWorkoutStateV2(value)
  if (!result.ok) throw new WorkoutP1Error('BACKUP_SCHEMA_INVALID', 'invalid workout-data-v2 root', result.issues)
  return result.value
}
