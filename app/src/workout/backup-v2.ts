import {
  WORKOUT_BACKUP_FORMAT,
  WorkoutP1Error,
  canonicalJson,
  canonicalizeLocalWorkoutStateV2,
  isIsoUtc,
  validateCompletedSessionV2,
  validateLocalWorkoutStateV2,
  type LocalWorkoutStateV2,
  type PreflightIssueV2,
  type WorkoutBackupV2,
} from './contracts-v2.ts'
import { migrateLegacyWorkoutDataV2 } from './plan-migration-v2.ts'
import { buildWorkoutSegments } from './runtime.ts'
import { materializeWorkoutPlanV2 } from './plan-migration-v2.ts'
import { replaceWorkoutRootV2, type WorkoutDataStorageAdapter } from './workout-data-v2.ts'

export type WorkoutBackupImportPreviewV2 = {
  version: 1 | 2
  state: LocalWorkoutStateV2
  issues: PreflightIssueV2[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(code: 'BACKUP_INVALID_JSON' | 'BACKUP_FORMAT_MISMATCH' | 'BACKUP_UNSUPPORTED_VERSION' | 'BACKUP_SCHEMA_INVALID', message: string, issues?: PreflightIssueV2[]): never {
  throw new WorkoutP1Error(code, message, issues)
}

function validateStateReferences(state: LocalWorkoutStateV2) {
  const issues: PreflightIssueV2[] = []
  for (const [index, plan] of state.plans.entries()) {
    try {
      materializeWorkoutPlanV2(plan, undefined, plan.executionPolicy === 'save_only' ? 'headless_preflight' : 'fixed_runtime')
    } catch (error) {
      const code = error instanceof WorkoutP1Error ? error.code : 'PLAN_REFERENCE_MISSING'
      issues.push({ code, severity: 'error', path: `$.payload.plans[${index}]`, entityId: plan.id, message: (error as Error).message })
    }
  }
  for (const [index, session] of state.sessions.entries()) {
    const planRecord = state.plans.find((plan) => plan.id === session.planId)
    if (!planRecord) {
      issues.push({ code: 'PLAN_REFERENCE_MISSING', severity: 'error', path: `$.payload.sessions[${index}].planId`, entityId: session.sessionId, message: 'session plan reference is missing' })
      continue
    }
    try {
      const plan = materializeWorkoutPlanV2(planRecord, undefined, 'headless_preflight')
      const validation = validateCompletedSessionV2(session, buildWorkoutSegments(plan).map((segment) => segment.id))
      issues.push(...validation.issues.map((item) => ({ ...item, path: `$.payload.sessions[${index}]${item.path.slice(1)}` })))
    } catch (error) {
      issues.push({ code: 'PLAN_REFERENCE_MISSING', severity: 'error', path: `$.payload.sessions[${index}].planId`, entityId: session.sessionId, message: (error as Error).message })
    }
  }
  return issues
}

export function exportWorkoutBackupV2(state: LocalWorkoutStateV2, exportedAt: string): WorkoutBackupV2 {
  if (!isIsoUtc(exportedAt)) fail('BACKUP_SCHEMA_INVALID', 'exportedAt must be a valid ISO UTC timestamp')
  const validation = validateLocalWorkoutStateV2(state)
  if (!validation.ok) fail('BACKUP_SCHEMA_INVALID', 'invalid local state cannot be exported', validation.issues)
  const references = validateStateReferences(validation.value)
  if (references.length) fail('BACKUP_SCHEMA_INVALID', 'invalid references cannot be exported', references)
  return { format: WORKOUT_BACKUP_FORMAT, version: 2, exportedAt, payload: canonicalizeLocalWorkoutStateV2(validation.value) }
}

export function serializeWorkoutBackupV2(state: LocalWorkoutStateV2, exportedAt: string) {
  return JSON.stringify(exportWorkoutBackupV2(state, exportedAt), null, 2)
}

export function previewWorkoutBackupImportV2(
  text: string,
  options: { importedAt: string; knownVoiceIds: readonly string[] },
): WorkoutBackupImportPreviewV2 {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { fail('BACKUP_INVALID_JSON', 'backup is not valid JSON') }
  if (!isRecord(parsed) || parsed.format !== WORKOUT_BACKUP_FORMAT) fail('BACKUP_FORMAT_MISMATCH', 'backup format does not match')
  if (parsed.version !== 1 && parsed.version !== 2) fail('BACKUP_UNSUPPORTED_VERSION', `backup version ${String(parsed.version)} is not supported`)
  if (parsed.version === 2) {
    if (Object.keys(parsed).some((key) => !['format', 'version', 'exportedAt', 'payload'].includes(key))) fail('BACKUP_SCHEMA_INVALID', 'backup v2 contains unexpected fields')
    if (!isIsoUtc(parsed.exportedAt) || !('payload' in parsed)) fail('BACKUP_SCHEMA_INVALID', 'backup v2 envelope is invalid')
    const validation = validateLocalWorkoutStateV2(parsed.payload)
    if (!validation.ok) fail('BACKUP_SCHEMA_INVALID', 'backup v2 payload is invalid', validation.issues)
    if (validation.value.selectedVoiceId !== null && !options.knownVoiceIds.includes(validation.value.selectedVoiceId)) fail('BACKUP_SCHEMA_INVALID', 'backup v2 selected voice reference is unknown')
    const references = validateStateReferences(validation.value)
    if (references.length) fail('BACKUP_SCHEMA_INVALID', 'backup v2 references are invalid', references)
    return { version: 2, state: canonicalizeLocalWorkoutStateV2(validation.value), issues: [] }
  }
  if (Object.keys(parsed).some((key) => !['format', 'version', 'exportedAt', 'activePlan', 'savedPlans', 'sessions', 'lastSession', 'selectedVoiceId'].includes(key))) fail('BACKUP_SCHEMA_INVALID', 'backup v1 contains unexpected fields')
  if (!('activePlan' in parsed) || !Array.isArray(parsed.savedPlans) || !Array.isArray(parsed.sessions)) fail('BACKUP_SCHEMA_INVALID', 'backup v1 required fields are missing')
  if ('lastSession' in parsed && parsed.lastSession !== null && !isRecord(parsed.lastSession)) fail('BACKUP_SCHEMA_INVALID', 'backup v1 lastSession is invalid')
  if ('exportedAt' in parsed && !isIsoUtc(parsed.exportedAt)) fail('BACKUP_SCHEMA_INVALID', 'backup v1 exportedAt is invalid')
  if ('selectedVoiceId' in parsed && parsed.selectedVoiceId !== undefined && typeof parsed.selectedVoiceId !== 'string') fail('BACKUP_SCHEMA_INVALID', 'backup v1 selectedVoiceId is invalid')
  const preview = migrateLegacyWorkoutDataV2({
    activePlan: parsed.activePlan,
    savedPlans: parsed.savedPlans,
    sessions: parsed.sessions,
    lastSession: parsed.lastSession ?? null,
    selectedVoiceId: parsed.selectedVoiceId,
  }, { source: 'backup-v1', migratedAt: options.importedAt, knownVoiceIds: options.knownVoiceIds })
  const structuralRejections = preview.entities.filter((entry) => entry.status === 'rejected' && ['PLAN_SCHEMA_INVALID', 'BACKUP_SCHEMA_INVALID'].includes(entry.code ?? ''))
  if (structuralRejections.length) fail('BACKUP_SCHEMA_INVALID', 'backup v1 contains invalid nested entities', structuralRejections.map((entry) => ({ code: entry.code ?? 'BACKUP_SCHEMA_INVALID', severity: 'error', path: '$.payload', entityId: entry.entityId, message: 'legacy entity failed validation' })))
  return { version: 1, state: preview.state, issues: preview.issues }
}

export async function importWorkoutBackupV2(
  adapter: WorkoutDataStorageAdapter,
  text: string,
  options: { importedAt: string; knownVoiceIds: readonly string[] },
) {
  const preview = previewWorkoutBackupImportV2(text, options)
  try {
    const state = await replaceWorkoutRootV2(adapter, preview.state)
    return { ...preview, state }
  } catch (error) {
    if (error instanceof WorkoutP1Error && error.code === 'BACKUP_PERSIST_FAILED') throw error
    throw new WorkoutP1Error('BACKUP_PERSIST_FAILED', `backup persistence failed: ${(error as Error).message}`)
  }
}

export function backupPayloadRoundTripEqual(state: LocalWorkoutStateV2, firstExportedAt: string, secondExportedAt: string) {
  const first = exportWorkoutBackupV2(state, firstExportedAt)
  const imported = previewWorkoutBackupImportV2(JSON.stringify(first), { importedAt: secondExportedAt, knownVoiceIds: state.selectedVoiceId ? [state.selectedVoiceId] : [] })
  const second = exportWorkoutBackupV2(imported.state, secondExportedAt)
  return canonicalJson(first.payload) === canonicalJson(second.payload)
}
