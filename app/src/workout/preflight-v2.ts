import {
  FIXED_RUNTIME_PLAN_ID,
  WORKOUT_P1_CONTRACT_VERSION,
  canonicalJson,
  validateCompletedSessionV2,
  validateLocalWorkoutStateV2,
  type LocalWorkoutStateV2,
  type PreflightIssueV2,
  type WorkoutDataPreflightV2,
} from './contracts-v2.ts'
import { backupPayloadRoundTripEqual } from './backup-v2.ts'
import { DEFAULT_WORKOUT_RESOURCE_CATALOG_V2, materializeWorkoutPlanV2, type WorkoutResourceCatalogV2 } from './plan-migration-v2.ts'
import { buildWorkoutSegments, calculatePlannedDurationMs, guidedWorkoutPlanV2, validateWorkoutPlan } from './runtime.ts'

function error(code: string, path: string, message: string, entityId?: string): PreflightIssueV2 {
  return { code, severity: 'error', path, message, ...(entityId ? { entityId } : {}) }
}

function fixedRuntimeIssues(plan = guidedWorkoutPlanV2) {
  const issues: PreflightIssueV2[] = []
  const segments = buildWorkoutSegments(plan)
  if (plan.id !== FIXED_RUNTIME_PLAN_ID || plan.rounds !== 3 || plan.exercises.map((exercise) => exercise.exerciseId).join(',') !== 'goblet-squat,romanian-deadlift,reverse-lunge,glute-bridge') issues.push(error('PLAN_SCHEMA_INVALID', '$.fixedRuntimePlanId', 'fixed runtime identity or exercise order changed'))
  if (segments.length !== 25 || calculatePlannedDurationMs(plan) !== 856_500 || plan.plannedDurationMs !== 856_500) issues.push(error('PLAN_DURATION_MISMATCH', '$.plans', 'fixed runtime must remain 25 segments and 856500ms'))
  if (segments.filter((segment) => segment.kind === 'transition_rest').some((segment) => canonicalJson(segment.events.map((event) => event.value)) !== canonicalJson([3, 2, 1]))) issues.push(error('PLAN_SCHEMA_INVALID', '$.plans', 'transition rest countdown changed'))
  if (segments.filter((segment) => segment.kind === 'round_rest').some((segment) => canonicalJson(segment.events.map((event) => event.value)) !== canonicalJson([5, 4, 3, 2, 1]))) issues.push(error('PLAN_SCHEMA_INVALID', '$.plans', 'round rest countdown changed'))
  issues.push(...validateWorkoutPlan(plan).map((message) => error(message.startsWith('planned duration') ? 'PLAN_DURATION_MISMATCH' : 'PLAN_SCHEMA_INVALID', '$.plans', message)))
  return issues
}

export function runWorkoutDataPreflightV2(
  state: LocalWorkoutStateV2,
  catalog: WorkoutResourceCatalogV2 = DEFAULT_WORKOUT_RESOURCE_CATALOG_V2,
): WorkoutDataPreflightV2 {
  const issues: PreflightIssueV2[] = []
  const validation = validateLocalWorkoutStateV2(state)
  if (!validation.ok) issues.push(...validation.issues)
  const safeState = validation.ok ? validation.value : state
  const readyPersonalIds: string[] = []
  let fixedRuntimeReady = false
  for (const [index, record] of safeState.plans.entries()) {
    if (record.source === 'personal' && record.executionPolicy !== 'save_only') issues.push(error('PLAN_PERSONAL_RUNTIME_FORBIDDEN', `$.plans[${index}].executionPolicy`, 'personal runtime is forbidden', record.id))
    try {
      const materialized = materializeWorkoutPlanV2(record, catalog, record.executionPolicy === 'save_only' ? 'headless_preflight' : 'fixed_runtime')
      const second = materializeWorkoutPlanV2(record, catalog, 'headless_preflight')
      if (canonicalJson(materialized) !== canonicalJson(second)) issues.push(error('PLAN_SCHEMA_INVALID', `$.plans[${index}]`, 'timeline materialization is not deterministic', record.id))
      if (record.id === FIXED_RUNTIME_PLAN_ID && record.executionPolicy === 'fixed_entry') {
        const fixedIssues = fixedRuntimeIssues(materialized)
        issues.push(...fixedIssues)
        fixedRuntimeReady = fixedIssues.length === 0
      } else if (record.source === 'personal' && record.executionPolicy === 'save_only') readyPersonalIds.push(record.id)
    } catch (caught) {
      const code = typeof caught === 'object' && caught !== null && 'code' in caught ? String(caught.code) : 'PLAN_REFERENCE_MISSING'
      issues.push(error(code, `$.plans[${index}]`, (caught as Error).message, record.id))
    }
  }
  const fixedEntries = safeState.plans.filter((plan) => plan.executionPolicy === 'fixed_entry')
  if (fixedEntries.length !== 1 || fixedEntries[0]?.id !== FIXED_RUNTIME_PLAN_ID || safeState.fixedRuntimePlanId !== FIXED_RUNTIME_PLAN_ID) issues.push(error('PLAN_PERSONAL_RUNTIME_FORBIDDEN', '$.fixedRuntimePlanId', 'there must be exactly one fixed runtime entry'))
  for (const [index, session] of safeState.sessions.entries()) {
    const record = safeState.plans.find((plan) => plan.id === session.planId)
    if (!record) { issues.push(error('PLAN_REFERENCE_MISSING', `$.sessions[${index}].planId`, 'session plan reference is missing', session.sessionId)); continue }
    try {
      const plan = materializeWorkoutPlanV2(record, catalog, 'headless_preflight')
      const sessionValidation = validateCompletedSessionV2(session, buildWorkoutSegments(plan).map((segment) => segment.id))
      issues.push(...sessionValidation.issues.map((entry) => ({ ...entry, path: `$.sessions[${index}]${entry.path.slice(1)}` })))
    } catch (caught) { issues.push(error('PLAN_REFERENCE_MISSING', `$.sessions[${index}].planId`, (caught as Error).message, session.sessionId)) }
  }
  let backupRoundTripValid = false
  if (!issues.some((entry) => entry.severity === 'error')) {
    try { backupRoundTripValid = backupPayloadRoundTripEqual(safeState, '2026-07-29T12:00:00.000Z', '2026-07-29T12:01:00.000Z') } catch (caught) { issues.push(error('BACKUP_SCHEMA_INVALID', '$', (caught as Error).message)) }
  }
  if (!backupRoundTripValid && !issues.some((entry) => entry.code === 'BACKUP_SCHEMA_INVALID')) issues.push(error('BACKUP_SCHEMA_INVALID', '$', 'backup canonical roundtrip failed'))
  const schemaValid = validation.ok
  const migrationValid = schemaValid && safeState.fixedRuntimePlanId === FIXED_RUNTIME_PLAN_ID && !issues.some((entry) => ['MIGRATION_ID_CONFLICT', 'MIGRATION_RULE_MISSING'].includes(entry.code))
  return {
    contractVersion: WORKOUT_P1_CONTRACT_VERSION,
    schemaValid,
    migrationValid,
    backupRoundTripValid,
    fixedRuntimePlanId: FIXED_RUNTIME_PLAN_ID,
    fixedRuntimeReady,
    personalPlanDataReadyIds: [...new Set(readyPersonalIds)].sort(),
    personalPlanRuntimeEnabled: false,
    issues,
  }
}
