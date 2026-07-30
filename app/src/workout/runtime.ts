import type { CountingMode, StartingSide, TimelineEvent, WorkoutExerciseV2, WorkoutPlanV2 } from './contracts-v2'

export type { CountingMode, StartingSide, TimelineEvent, WorkoutExerciseV2, WorkoutPlanV2 } from './contracts-v2'

export type WorkoutState = 'idle' | 'preparing' | 'active' | 'rest' | 'paused' | 'detail' | 'completed' | 'exited'
export type RunningWorkoutState = 'preparing' | 'active' | 'rest'
export type PauseReason = 'manual' | 'background' | 'detail_return'

export type WorkoutSegmentKind = 'preparation' | 'active' | 'transition_rest' | 'round_rest' | 'cooldown'

export type WorkoutSegment = {
  id: string
  kind: WorkoutSegmentKind
  durationMs: number
  roundIndex: number
  exerciseIndex?: number
  exerciseId?: string
  events: TimelineEvent[]
}

export type WorkoutRuntimeAuditV2 = {
  wallStartedAtMs: number | null
  activeElapsedMs: number
  processedTransitionIds: string[]
  completedSegmentIds: string[]
  skippedSegmentIds: string[]
  completionEventId?: string
}

export type WorkoutRuntimeV2 = WorkoutRuntimeAuditV2 & {
  sessionId: string
  planId: string
  planVersion: 2
  plannedDurationMs: number
  state: WorkoutState
  resumeTarget?: RunningWorkoutState
  pauseReason?: PauseReason
  segmentIndex: number
  roundIndex: number
  exerciseIndex: number
  segmentStartedAtMs: number | null
  accumulatedSegmentMs: number
  lastEvaluatedElapsedMs: number
  completedCount: number
  leftCompleted: number
  rightCompleted: number
  announcedEventIds: string[]
  suppressedEventIds: string[]
  skippedExerciseIds: string[]
  voiceVariantSeed: number
  wallCompletedAtMs: number | null
}

export type WorkoutVoiceEvent = {
  eventId: string
  value: number
  type: 'rep_complete' | 'pair_complete' | 'countdown_number'
  segmentIndex: number
  roundIndex: number
  exerciseIndex?: number
  plannedAtMs: number
  latenessMs: number
  variantIndex: number
}

export type WorkoutClockSnapshotV2 = {
  runtime: WorkoutRuntimeV2
  segment: WorkoutSegment
  segmentElapsedMs: number
  segmentRemainingMs: number
  remainingSeconds: number
  plannedElapsedMs: number
  progress: number
}

export type WorkoutAdvanceResult = {
  runtime: WorkoutRuntimeV2
  snapshot: WorkoutClockSnapshotV2
  voiceEvents: WorkoutVoiceEvent[]
  segmentChanged: boolean
}

const COUNT_AUDIO_MAX = 40
const AUDIO_FRESHNESS_MS = 250

function countAudioVariants() {
  return Object.fromEntries(Array.from({ length: COUNT_AUDIO_MAX }, (_, index) => {
    const value = index + 1
    const padded = String(value).padStart(2, '0')
    return [value, [`/media/audio/count-low-${padded}.wav`, `/media/audio/count-low-${padded}-v2.wav`]]
  }))
}

export function buildCountdownTimeline(durationMs: number, seconds: number[], prefix = 'countdown') {
  return seconds
    .filter((value, index, values) => value > 0 && value * 1000 <= durationMs && values.indexOf(value) === index)
    .sort((a, b) => b - a)
    .map((value) => ({ id: `${prefix}-${value}`, atMs: durationMs - value * 1000, type: 'countdown_number' as const, value }))
}

function buildRepetitionTimeline(targetCount: number, cycleDurationMs: number) {
  return Array.from({ length: targetCount }, (_, index) => {
    const value = index + 1
    return { id: `rep-${value}`, atMs: value * cycleDurationMs, type: 'rep_complete' as const, value }
  })
}

function buildAlternatingTimeline(targetPerSide: number, cycleDurationMs: number, startingSide: StartingSide) {
  const firstSide: TimelineEvent['type'] = startingSide === 'left' ? 'left_complete' : 'right_complete'
  const secondSide: TimelineEvent['type'] = startingSide === 'left' ? 'right_complete' : 'left_complete'
  return Array.from({ length: targetPerSide }, (_, index) => {
    const value = index + 1
    const cycleStartMs = index * cycleDurationMs
    return [
      { id: `${firstSide}-${value}`, atMs: cycleStartMs + cycleDurationMs / 2, type: firstSide, value },
      { id: `${secondSide}-${value}`, atMs: cycleStartMs + cycleDurationMs, type: secondSide, value },
      { id: `pair-${value}`, atMs: cycleStartMs + cycleDurationMs, type: 'pair_complete' as const, value },
    ]
  }).flat()
}

const audioVariants = countAudioVariants()

export const guidedWorkoutPlanV2: WorkoutPlanV2 = {
  id: 'lower-body-guided-15m-v2',
  version: 2,
  title: '15 分钟臀腿跟练',
  displayDurationMinutes: 15,
  plannedDurationMs: 860_000,
  allowedDeviationMs: 30_000,
  // The preparation segment is a short voice-led pre-roll, not a 30-second
  // waiting room.  The first action begins immediately after the 3-2-1 cue.
  // The intro and first action-name cue are queued back-to-back. Reserve
  // enough time for both phrases before the first rep timeline begins.
  preparationMs: 8_000,
  transitionRestMs: 20_000,
  roundRestMs: 60_000,
  cooldownMs: 60_000,
  rounds: 3,
  exercises: [
    {
      exerciseId: 'goblet-squat',
      countingMode: 'repetition',
      targetCount: 10,
      cycleDurationMs: 4_000,
      segmentDurationMs: 40_000,
      timelineEvents: buildRepetitionTimeline(10, 4_000),
      videoUri: '/media/actions/videos/goblet-squat.mp4',
      videoFallbackUri: '/media/actions/videos/goblet-squat.webm',
      posterUri: '/media/actions/posters/goblet-squat-poster.png',
      countAudioVariants: audioVariants,
    },
    {
      exerciseId: 'romanian-deadlift',
      countingMode: 'repetition',
      targetCount: 10,
      cycleDurationMs: 4_000,
      segmentDurationMs: 40_000,
      timelineEvents: buildRepetitionTimeline(10, 4_000),
      videoUri: '/media/actions/videos/romanian-deadlift.mp4',
      videoFallbackUri: '/media/actions/videos/romanian-deadlift.webm',
      posterUri: '/media/actions/posters/dumbbell-romanian-deadlift-poster.png',
      countAudioVariants: audioVariants,
    },
    {
      exerciseId: 'reverse-lunge',
      countingMode: 'alternating_pair',
      targetPerSide: 8,
      startingSide: 'left',
      cycleDurationMs: 6_000,
      segmentDurationMs: 48_000,
      timelineEvents: buildAlternatingTimeline(8, 6_000, 'left'),
      videoUri: '/media/actions/videos/reverse-lunge.mp4',
      videoFallbackUri: '/media/actions/videos/reverse-lunge.webm',
      posterUri: '/media/actions/posters/reverse-lunge-poster.png',
      countAudioVariants: audioVariants,
    },
    {
      exerciseId: 'glute-bridge',
      countingMode: 'repetition',
      targetCount: 12,
      cycleDurationMs: 3_000,
      segmentDurationMs: 36_000,
      timelineEvents: buildRepetitionTimeline(12, 3_000),
      videoUri: '/media/actions/videos/glute-bridge.mp4',
      videoFallbackUri: '/media/actions/videos/glute-bridge.webm',
      posterUri: '/media/actions/posters/dumbbell-glute-bridge-poster.png',
      countAudioVariants: audioVariants,
    },
  ],
}

function segmentState(kind: WorkoutSegmentKind): RunningWorkoutState {
  if (kind === 'preparation') return 'preparing'
  if (kind === 'active') return 'active'
  return 'rest'
}

const workoutSegmentCache = new WeakMap<WorkoutPlanV2, WorkoutSegment[]>()
const segmentOffsetCache = new WeakMap<WorkoutPlanV2, number[]>()

export function buildWorkoutSegments(plan: WorkoutPlanV2): WorkoutSegment[] {
  const cached = workoutSegmentCache.get(plan)
  if (cached) return cached
  const segments: WorkoutSegment[] = []
  if (plan.preparationMs > 0) {
    segments.push({
      id: 'preparation',
      kind: 'preparation',
      durationMs: plan.preparationMs,
      roundIndex: 0,
      exerciseIndex: 0,
      exerciseId: plan.exercises[0]?.exerciseId,
      // The preparation numbers are spoken by the single intro cue so they
      // cannot race the action-name prompt or be replayed after a late frame.
      events: [],
    })
  }

  for (let roundIndex = 0; roundIndex < plan.rounds; roundIndex += 1) {
    plan.exercises.forEach((exercise, exerciseIndex) => {
      const activeEvents = exercise.countingMode === 'timed'
        ? [
            ...exercise.timelineEvents.filter((event) => event.type !== 'countdown_number'),
            ...buildCountdownTimeline(exercise.segmentDurationMs, exercise.countdownCueSeconds ?? [10, 5, 4, 3, 2, 1], `timed-${exercise.exerciseId}`),
          ]
        : exercise.timelineEvents
      segments.push({
        id: `round-${roundIndex + 1}-exercise-${exerciseIndex + 1}`,
        kind: 'active',
        durationMs: exercise.segmentDurationMs,
        roundIndex,
        exerciseIndex,
        exerciseId: exercise.exerciseId,
        events: activeEvents,
      })
      if (exerciseIndex < plan.exercises.length - 1) {
        const nextExercise = plan.exercises[exerciseIndex + 1]
        segments.push({
          id: `round-${roundIndex + 1}-transition-${exerciseIndex + 1}`,
          kind: 'transition_rest',
          durationMs: plan.transitionRestMs,
          roundIndex,
          exerciseIndex: exerciseIndex + 1,
          exerciseId: nextExercise.exerciseId,
          events: buildCountdownTimeline(plan.transitionRestMs, [3, 2, 1], 'rest'),
        })
      }
    })

    if (roundIndex < plan.rounds - 1) {
      segments.push({
        id: `round-${roundIndex + 1}-rest`,
        kind: 'round_rest',
        durationMs: plan.roundRestMs,
        roundIndex,
        exerciseIndex: 0,
        exerciseId: plan.exercises[0]?.exerciseId,
        events: buildCountdownTimeline(plan.roundRestMs, [5, 4, 3, 2, 1], 'round-rest'),
      })
    }
  }

  if (plan.cooldownMs > 0) {
    segments.push({
      id: 'cooldown',
      kind: 'cooldown',
      durationMs: plan.cooldownMs,
      roundIndex: Math.max(0, plan.rounds - 1),
      exerciseIndex: Math.max(0, plan.exercises.length - 1),
      exerciseId: plan.exercises[plan.exercises.length - 1]?.exerciseId,
      events: [],
    })
  }
  workoutSegmentCache.set(plan, segments)
  return segments
}

function segmentStartOffsets(plan: WorkoutPlanV2) {
  const cached = segmentOffsetCache.get(plan)
  if (cached) return cached
  const segments = buildWorkoutSegments(plan)
  let cursor = 0
  const offsets = segments.map((segment) => {
    const startMs = cursor
    cursor += segment.durationMs
    return startMs
  })
  segmentOffsetCache.set(plan, offsets)
  return offsets
}

export function calculatePlannedDurationMs(plan: WorkoutPlanV2) {
  return buildWorkoutSegments(plan).reduce((sum, segment) => sum + segment.durationMs, 0)
}

export function validateWorkoutPlan(plan: WorkoutPlanV2) {
  const errors: string[] = []
  for (const exercise of plan.exercises) {
    const targets = [exercise.targetCount !== undefined, exercise.targetSeconds !== undefined, exercise.targetPerSide !== undefined].filter(Boolean).length
    if (targets !== 1) errors.push(`${exercise.exerciseId}: counting target must be exclusive`)
    if (exercise.countingMode === 'repetition') {
      if (!exercise.targetCount || !exercise.cycleDurationMs || exercise.targetCount * exercise.cycleDurationMs !== exercise.segmentDurationMs) errors.push(`${exercise.exerciseId}: repetition duration mismatch`)
      const events = exercise.timelineEvents.filter((event) => event.type === 'rep_complete')
      if (events.length !== exercise.targetCount || events[events.length - 1]?.atMs !== exercise.segmentDurationMs) errors.push(`${exercise.exerciseId}: repetition timeline mismatch`)
    }
    if (exercise.countingMode === 'alternating_pair') {
      if (!exercise.targetPerSide || !exercise.cycleDurationMs || exercise.targetPerSide * exercise.cycleDurationMs !== exercise.segmentDurationMs) errors.push(`${exercise.exerciseId}: alternating duration mismatch`)
      const pairEvents = exercise.timelineEvents.filter((event) => event.type === 'pair_complete')
      const leftEvents = exercise.timelineEvents.filter((event) => event.type === 'left_complete')
      const rightEvents = exercise.timelineEvents.filter((event) => event.type === 'right_complete')
      if (pairEvents.length !== exercise.targetPerSide || leftEvents.length !== exercise.targetPerSide || rightEvents.length !== exercise.targetPerSide || pairEvents[pairEvents.length - 1]?.atMs !== exercise.segmentDurationMs) errors.push(`${exercise.exerciseId}: alternating timeline mismatch`)
    }
    if (exercise.countingMode === 'timed') {
      if (!exercise.targetSeconds || exercise.targetSeconds * 1000 !== exercise.segmentDurationMs) errors.push(`${exercise.exerciseId}: timed duration mismatch`)
      if (exercise.timelineEvents.some((event) => event.type === 'rep_complete' || event.type === 'pair_complete')) errors.push(`${exercise.exerciseId}: timed exercise contains repetition events`)
    }
  }
  if (calculatePlannedDurationMs(plan) !== plan.plannedDurationMs) errors.push(`planned duration mismatch: expected ${plan.plannedDurationMs}, calculated ${calculatePlannedDurationMs(plan)}`)
  return errors
}

function hashSessionId(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(31, hash) + value.charCodeAt(index) | 0
  return Math.abs(hash)
}

export function createWorkoutRuntime(plan: WorkoutPlanV2, sessionId: string): WorkoutRuntimeV2 {
  return {
    sessionId,
    planId: plan.id,
    planVersion: plan.version,
    plannedDurationMs: plan.plannedDurationMs,
    state: 'idle',
    segmentIndex: 0,
    roundIndex: 0,
    exerciseIndex: 0,
    segmentStartedAtMs: null,
    accumulatedSegmentMs: 0,
    lastEvaluatedElapsedMs: 0,
    completedCount: 0,
    leftCompleted: 0,
    rightCompleted: 0,
    announcedEventIds: [],
    suppressedEventIds: [],
    skippedExerciseIds: [],
    voiceVariantSeed: hashSessionId(sessionId),
    wallStartedAtMs: null,
    wallCompletedAtMs: null,
    activeElapsedMs: 0,
    processedTransitionIds: [],
    completedSegmentIds: [],
    skippedSegmentIds: [],
  }
}

function cloneRuntime(runtime: WorkoutRuntimeV2): WorkoutRuntimeV2 {
  return {
    ...runtime,
    announcedEventIds: [...runtime.announcedEventIds],
    suppressedEventIds: [...runtime.suppressedEventIds],
    skippedExerciseIds: [...runtime.skippedExerciseIds],
    processedTransitionIds: [...runtime.processedTransitionIds],
    completedSegmentIds: [...runtime.completedSegmentIds],
    skippedSegmentIds: [...runtime.skippedSegmentIds],
  }
}

function isRunningState(state: WorkoutState): state is RunningWorkoutState {
  return state === 'preparing' || state === 'active' || state === 'rest'
}

function applyTimelineEvent(runtime: WorkoutRuntimeV2, event: TimelineEvent) {
  if (event.type === 'rep_complete' || event.type === 'pair_complete') runtime.completedCount = event.value ?? runtime.completedCount
  if (event.type === 'left_complete') runtime.leftCompleted = event.value ?? runtime.leftCompleted
  if (event.type === 'right_complete') runtime.rightCompleted = event.value ?? runtime.rightCompleted
}

function resetSegmentProgress(runtime: WorkoutRuntimeV2, segment: WorkoutSegment, segmentStartedAtMs: number | null) {
  runtime.roundIndex = segment.roundIndex
  runtime.exerciseIndex = segment.exerciseIndex ?? 0
  runtime.segmentStartedAtMs = segmentStartedAtMs
  runtime.accumulatedSegmentMs = 0
  runtime.lastEvaluatedElapsedMs = 0
  runtime.completedCount = 0
  runtime.leftCompleted = 0
  runtime.rightCompleted = 0
  runtime.state = segmentState(segment.kind)
  runtime.resumeTarget = undefined
  runtime.pauseReason = undefined
}

function snapshotFor(runtime: WorkoutRuntimeV2, plan: WorkoutPlanV2, segmentElapsedMs: number): WorkoutClockSnapshotV2 {
  const segments = buildWorkoutSegments(plan)
  const segment = segments[Math.min(runtime.segmentIndex, segments.length - 1)]
  const offsets = segmentStartOffsets(plan)
  const clampedElapsed = Math.min(segment.durationMs, Math.max(0, segmentElapsedMs))
  const plannedElapsedMs = runtime.state === 'completed' ? plan.plannedDurationMs : Math.min(plan.plannedDurationMs, offsets[runtime.segmentIndex] + clampedElapsed)
  return {
    runtime,
    segment,
    segmentElapsedMs: clampedElapsed,
    segmentRemainingMs: Math.max(0, segment.durationMs - clampedElapsed),
    remainingSeconds: Math.ceil(Math.max(0, segment.durationMs - clampedElapsed) / 1000),
    plannedElapsedMs,
    progress: plan.plannedDurationMs ? plannedElapsedMs / plan.plannedDurationMs : 0,
  }
}

export function getWorkoutSnapshot(runtime: WorkoutRuntimeV2, plan: WorkoutPlanV2, nowMs: number): WorkoutClockSnapshotV2 {
  const segment = buildWorkoutSegments(plan)[Math.min(runtime.segmentIndex, buildWorkoutSegments(plan).length - 1)]
  const elapsed = isRunningState(runtime.state) && runtime.segmentStartedAtMs !== null
    ? runtime.accumulatedSegmentMs + Math.max(0, nowMs - runtime.segmentStartedAtMs)
    : runtime.accumulatedSegmentMs
  return snapshotFor(runtime, plan, Math.min(segment.durationMs, elapsed))
}

function voiceVariantIndex(runtime: WorkoutRuntimeV2, segment: WorkoutSegment) {
  return Math.abs(runtime.voiceVariantSeed + segment.roundIndex * 31 + (segment.exerciseIndex ?? runtime.segmentIndex) * 17) % 2
}

export function startWorkoutRuntime(runtime: WorkoutRuntimeV2, plan: WorkoutPlanV2, nowMs: number) {
  if (runtime.state !== 'idle') return runtime
  const next = cloneRuntime(runtime)
  const firstSegment = buildWorkoutSegments(plan)[0]
  next.wallStartedAtMs = nowMs
  resetSegmentProgress(next, firstSegment, nowMs)
  return next
}

function applySegmentTransition(runtime: WorkoutRuntimeV2, segment: WorkoutSegment, eventType: 'completed' | 'skipped') {
  const transitionId = `${runtime.sessionId}/${segment.id}/segment_${eventType}/1`
  if (runtime.processedTransitionIds.includes(transitionId)) return false
  runtime.processedTransitionIds.push(transitionId)
  const target = eventType === 'completed' ? runtime.completedSegmentIds : runtime.skippedSegmentIds
  if (!target.includes(segment.id)) target.push(segment.id)
  return true
}

function completeRuntime(runtime: WorkoutRuntimeV2, nowMs: number) {
  runtime.state = 'completed'
  runtime.segmentStartedAtMs = null
  runtime.wallCompletedAtMs ??= nowMs
  runtime.completionEventId ??= `${runtime.sessionId}/workout/completed/1`
}

export function advanceWorkoutRuntime(runtime: WorkoutRuntimeV2, plan: WorkoutPlanV2, nowMs: number, suppressAudio = false): WorkoutAdvanceResult {
  const next = cloneRuntime(runtime)
  const segments = buildWorkoutSegments(plan)
  const offsets = segmentStartOffsets(plan)
  if (!isRunningState(next.state) || next.segmentStartedAtMs === null) {
    return { runtime: next, snapshot: getWorkoutSnapshot(next, plan, nowMs), voiceEvents: [], segmentChanged: false }
  }

  const crossedVoiceEvents: Array<Omit<WorkoutVoiceEvent, 'latenessMs' | 'variantIndex'>> = []
  let rawElapsedMs = next.accumulatedSegmentMs + Math.max(0, nowMs - next.segmentStartedAtMs)
  let segmentChanged = false
  let finalElapsedMs = rawElapsedMs

  while (true) {
    const segment = segments[next.segmentIndex]
    const previouslyEvaluatedMs = next.lastEvaluatedElapsedMs
    const evaluatedElapsedMs = Math.min(segment.durationMs, rawElapsedMs)
    const crossedEvents = segment.events
      .filter((event) => event.atMs > next.lastEvaluatedElapsedMs && event.atMs <= evaluatedElapsedMs)
      .sort((a, b) => a.atMs - b.atMs)

    for (const event of crossedEvents) {
      applyTimelineEvent(next, event)
      if ((event.type === 'rep_complete' || event.type === 'pair_complete' || event.type === 'countdown_number') && event.value !== undefined) {
        crossedVoiceEvents.push({
          eventId: `${segment.id}:${event.id}`,
          value: event.value,
          type: event.type,
          segmentIndex: next.segmentIndex,
          roundIndex: segment.roundIndex,
          exerciseIndex: segment.exerciseIndex,
          plannedAtMs: offsets[next.segmentIndex] + event.atMs,
        })
      }
    }
    next.lastEvaluatedElapsedMs = evaluatedElapsedMs
    next.activeElapsedMs += Math.max(0, evaluatedElapsedMs - previouslyEvaluatedMs)
    finalElapsedMs = evaluatedElapsedMs

    if (rawElapsedMs < segment.durationMs) break
    applySegmentTransition(next, segment, 'completed')
    if (next.segmentIndex >= segments.length - 1) {
      completeRuntime(next, nowMs)
      next.accumulatedSegmentMs = segment.durationMs
      next.lastEvaluatedElapsedMs = segment.durationMs
      finalElapsedMs = segment.durationMs
      break
    }

    const overflowMs = rawElapsedMs - segment.durationMs
    next.segmentIndex += 1
    const followingSegment = segments[next.segmentIndex]
    resetSegmentProgress(next, followingSegment, nowMs - overflowMs)
    rawElapsedMs = overflowMs
    segmentChanged = true
  }

  const snapshot = snapshotFor(next, plan, finalElapsedMs)
  const announced = new Set(next.announcedEventIds)
  const suppressed = new Set(next.suppressedEventIds)
  const pending = crossedVoiceEvents.filter((event) => !announced.has(event.eventId) && !suppressed.has(event.eventId))
  const withLateness = pending.map((event) => ({
    ...event,
    latenessMs: Math.max(0, snapshot.plannedElapsedMs - event.plannedAtMs),
    variantIndex: voiceVariantIndex(next, segments[event.segmentIndex]),
  }))
  const fresh = suppressAudio ? [] : withLateness.filter((event) => event.latenessMs <= AUDIO_FRESHNESS_MS)
  const selected = fresh[fresh.length - 1]
  for (const event of withLateness) {
    if (event.eventId === selected?.eventId) announced.add(event.eventId)
    else suppressed.add(event.eventId)
  }
  next.announcedEventIds = [...announced]
  next.suppressedEventIds = [...suppressed]
  snapshot.runtime = next

  return { runtime: next, snapshot, voiceEvents: selected ? [selected] : [], segmentChanged }
}

function freezeRuntime(runtime: WorkoutRuntimeV2, plan: WorkoutPlanV2, nowMs: number, state: 'paused' | 'detail', reason?: PauseReason) {
  const evaluated = advanceWorkoutRuntime(runtime, plan, nowMs, true)
  const next = cloneRuntime(evaluated.runtime)
  if (!isRunningState(next.state)) return { ...evaluated, runtime: next, snapshot: snapshotFor(next, plan, evaluated.snapshot.segmentElapsedMs), voiceEvents: [] }
  next.resumeTarget = next.state
  next.state = state
  next.pauseReason = reason
  next.accumulatedSegmentMs = evaluated.snapshot.segmentElapsedMs
  next.segmentStartedAtMs = null
  const snapshot = snapshotFor(next, plan, next.accumulatedSegmentMs)
  return { ...evaluated, runtime: next, snapshot, voiceEvents: [] }
}

export function pauseWorkoutRuntime(runtime: WorkoutRuntimeV2, plan: WorkoutPlanV2, nowMs: number, reason: Exclude<PauseReason, 'detail_return'>) {
  return freezeRuntime(runtime, plan, nowMs, 'paused', reason)
}

export function enterWorkoutDetail(runtime: WorkoutRuntimeV2, plan: WorkoutPlanV2, nowMs: number) {
  if (runtime.state !== 'active') return { runtime, snapshot: getWorkoutSnapshot(runtime, plan, nowMs), voiceEvents: [], segmentChanged: false }
  return freezeRuntime(runtime, plan, nowMs, 'detail')
}

export function closeWorkoutDetail(runtime: WorkoutRuntimeV2, plan: WorkoutPlanV2, nowMs: number) {
  if (runtime.state !== 'detail') return runtime
  return { ...cloneRuntime(runtime), state: 'paused' as const, pauseReason: 'detail_return' as const, segmentStartedAtMs: null }
}

export function resumeWorkoutRuntime(runtime: WorkoutRuntimeV2, nowMs: number) {
  if (runtime.state !== 'paused' || !runtime.resumeTarget) return runtime
  return {
    ...cloneRuntime(runtime),
    state: runtime.resumeTarget,
    pauseReason: undefined,
    segmentStartedAtMs: nowMs,
  }
}

export function skipWorkoutSegment(runtime: WorkoutRuntimeV2, plan: WorkoutPlanV2, nowMs: number) {
  const evaluated = advanceWorkoutRuntime(runtime, plan, nowMs, true)
  const next = cloneRuntime(evaluated.runtime)
  const segments = buildWorkoutSegments(plan)
  const current = segments[next.segmentIndex]
  if (next.state !== 'active' && next.state !== 'rest') return { ...evaluated, runtime: next, voiceEvents: [] }
  if (current.kind === 'cooldown') return { ...evaluated, runtime: next, voiceEvents: [] }
  if (!applySegmentTransition(next, current, 'skipped')) return { ...evaluated, runtime: next, voiceEvents: [] }
  if (current.kind === 'active' && current.exerciseId) next.skippedExerciseIds.push(`${current.exerciseId}:round-${current.roundIndex + 1}`)
  if (next.segmentIndex >= segments.length - 1) {
    completeRuntime(next, nowMs)
    next.accumulatedSegmentMs = current.durationMs
  } else {
    next.segmentIndex += 1
    resetSegmentProgress(next, segments[next.segmentIndex], nowMs)
  }
  return { runtime: next, snapshot: getWorkoutSnapshot(next, plan, nowMs), voiceEvents: [], segmentChanged: true }
}

export function exitWorkoutRuntime(runtime: WorkoutRuntimeV2) {
  return { ...cloneRuntime(runtime), state: 'exited' as const, segmentStartedAtMs: null }
}
