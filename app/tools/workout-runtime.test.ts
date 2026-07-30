import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceWorkoutRuntime,
  buildCountdownTimeline,
  buildWorkoutSegments,
  calculatePlannedDurationMs,
  closeWorkoutDetail,
  createWorkoutRuntime,
  enterWorkoutDetail,
  exitWorkoutRuntime,
  getWorkoutSnapshot,
  guidedWorkoutPlanV2,
  pauseWorkoutRuntime,
  resumeWorkoutRuntime,
  skipWorkoutSegment,
  startWorkoutRuntime,
  validateWorkoutPlan,
  type WorkoutPlanV2,
} from '../src/workout/runtime.ts'

function startedRuntime() {
  return startWorkoutRuntime(createWorkoutRuntime(guidedWorkoutPlanV2, 'test-session'), guidedWorkoutPlanV2, 0)
}

test('the guided plan contains 25 segments and totals exactly 14:42', () => {
  assert.equal(validateWorkoutPlan(guidedWorkoutPlanV2).length, 0)
  assert.equal(buildWorkoutSegments(guidedWorkoutPlanV2).length, 25)
  assert.equal(calculatePlannedDurationMs(guidedWorkoutPlanV2), 882_000)
})

test('a repetition stays at zero until the first complete four-second cycle', () => {
  let runtime = startedRuntime()
  runtime = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 30_000).runtime
  let result = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 33_999)
  assert.equal(result.snapshot.runtime.completedCount, 0)
  assert.equal(result.voiceEvents.length, 0)

  result = advanceWorkoutRuntime(result.runtime, guidedWorkoutPlanV2, 34_000)
  assert.equal(result.snapshot.runtime.completedCount, 1)
  assert.deepEqual(result.voiceEvents.map((event) => event.value), [1])
})

test('an alternating pair reports one only after both sides finish', () => {
  let runtime = startedRuntime()
  runtime = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 150_000).runtime

  let result = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 153_000)
  assert.equal(result.snapshot.runtime.leftCompleted, 1)
  assert.equal(result.snapshot.runtime.rightCompleted, 0)
  assert.equal(result.snapshot.runtime.completedCount, 0)
  assert.equal(result.voiceEvents.length, 0)

  result = advanceWorkoutRuntime(result.runtime, guidedWorkoutPlanV2, 156_000)
  assert.equal(result.snapshot.runtime.leftCompleted, 1)
  assert.equal(result.snapshot.runtime.rightCompleted, 1)
  assert.equal(result.snapshot.runtime.completedCount, 1)
  assert.deepEqual(result.voiceEvents.map((event) => event.value), [1])
})

test('pause freezes exact milliseconds and resume neither resets nor replays', () => {
  let runtime = startedRuntime()
  runtime = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 32_000).runtime
  const paused = pauseWorkoutRuntime(runtime, guidedWorkoutPlanV2, 32_000, 'manual')
  assert.equal(paused.snapshot.segmentElapsedMs, 2_000)
  assert.equal(getWorkoutSnapshot(paused.runtime, guidedWorkoutPlanV2, 62_000).segmentElapsedMs, 2_000)

  runtime = resumeWorkoutRuntime(paused.runtime, 62_000)
  const resumed = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 64_000)
  assert.equal(resumed.snapshot.segmentElapsedMs, 4_000)
  assert.equal(resumed.snapshot.runtime.completedCount, 1)
  assert.deepEqual(resumed.voiceEvents.map((event) => event.value), [1])
})

test('late historical nodes update UI but are suppressed instead of replayed', () => {
  let runtime = startedRuntime()
  runtime = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 30_000).runtime
  const result = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 34_500)
  assert.equal(result.snapshot.runtime.completedCount, 1)
  assert.equal(result.voiceEvents.length, 0)
  assert.ok(result.runtime.suppressedEventIds.includes('round-1-exercise-1:rep-1'))
})

test('rest skip advances once and resets the next action to zero', () => {
  let runtime = startedRuntime()
  runtime = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 70_000).runtime
  assert.equal(runtime.state, 'rest')
  const skipped = skipWorkoutSegment(runtime, guidedWorkoutPlanV2, 70_000)
  assert.equal(skipped.runtime.state, 'active')
  assert.equal(skipped.runtime.exerciseIndex, 1)
  assert.equal(skipped.runtime.completedCount, 0)
  assert.equal(skipped.snapshot.segmentElapsedMs, 0)
})

test('a long stall completes at planned time without duplicate event ids', () => {
  const result = advanceWorkoutRuntime(startedRuntime(), guidedWorkoutPlanV2, 882_000)
  assert.equal(result.runtime.state, 'completed')
  assert.equal(result.snapshot.plannedElapsedMs, 882_000)
  assert.equal(new Set(result.runtime.announcedEventIds).size, result.runtime.announcedEventIds.length)
  assert.equal(new Set(result.runtime.suppressedEventIds).size, result.runtime.suppressedEventIds.length)
  assert.equal(result.runtime.announcedEventIds.some((id) => result.runtime.suppressedEventIds.includes(id)), false)
})

test('timed countdown nodes contain only 10, 5, 4, 3, 2, 1', () => {
  const events = buildCountdownTimeline(12_000, [10, 5, 4, 3, 2, 1])
  assert.deepEqual(events.map((event) => event.value), [10, 5, 4, 3, 2, 1])
  assert.deepEqual(events.map((event) => event.atMs), [2_000, 7_000, 8_000, 9_000, 10_000, 11_000])
})

test('a timed segment emits only configured countdown numbers and no fake count', () => {
  const timedPlan: WorkoutPlanV2 = {
    ...guidedWorkoutPlanV2,
    id: 'timed-test',
    plannedDurationMs: 12_000,
    preparationMs: 0,
    transitionRestMs: 0,
    roundRestMs: 0,
    cooldownMs: 0,
    rounds: 1,
    exercises: [{
      exerciseId: 'timed-hold',
      countingMode: 'timed',
      targetSeconds: 12,
      segmentDurationMs: 12_000,
      timelineEvents: [],
      countdownCueSeconds: [10, 5, 4, 3, 2, 1],
      videoUri: '/timed.webm',
      posterUri: '/timed.png',
      countAudioVariants: {},
    }],
  }
  let runtime = startWorkoutRuntime(createWorkoutRuntime(timedPlan, 'timed-session'), timedPlan, 0)
  let result = advanceWorkoutRuntime(runtime, timedPlan, 2_000)
  assert.equal(result.snapshot.runtime.completedCount, 0)
  assert.equal(result.snapshot.remainingSeconds, 10)
  assert.deepEqual(result.voiceEvents.map((event) => event.value), [10])
  runtime = result.runtime
  result = advanceWorkoutRuntime(runtime, timedPlan, 7_000)
  assert.equal(result.snapshot.runtime.completedCount, 0)
  assert.deepEqual(result.voiceEvents.map((event) => event.value), [5])
})

test('transition rests use 3, 2, 1 while round rests use 5 through 1', () => {
  const segments = buildWorkoutSegments(guidedWorkoutPlanV2)
  const transition = segments.find((segment) => segment.kind === 'transition_rest')
  const roundRest = segments.find((segment) => segment.kind === 'round_rest')
  assert.deepEqual(transition?.events.map((event) => event.value), [3, 2, 1])
  assert.deepEqual(roundRest?.events.map((event) => event.value), [5, 4, 3, 2, 1])
})

test('background pause freezes and never catches up before explicit resume', () => {
  let runtime = advanceWorkoutRuntime(startedRuntime(), guidedWorkoutPlanV2, 32_500).runtime
  const paused = pauseWorkoutRuntime(runtime, guidedWorkoutPlanV2, 32_500, 'background')
  assert.equal(paused.runtime.pauseReason, 'background')
  assert.equal(getWorkoutSnapshot(paused.runtime, guidedWorkoutPlanV2, 92_500).segmentElapsedMs, 2_500)
  runtime = resumeWorkoutRuntime(paused.runtime, 92_500)
  const resumed = advanceWorkoutRuntime(runtime, guidedWorkoutPlanV2, 94_000)
  assert.equal(resumed.snapshot.segmentElapsedMs, 4_000)
  assert.deepEqual(resumed.voiceEvents.map((event) => event.value), [1])
})

test('opening and closing detail ten times preserves position and returns paused', () => {
  let runtime = advanceWorkoutRuntime(startedRuntime(), guidedWorkoutPlanV2, 32_000).runtime
  let nowMs = 32_000
  for (let index = 0; index < 10; index += 1) {
    const detail = enterWorkoutDetail(runtime, guidedWorkoutPlanV2, nowMs)
    assert.equal(detail.runtime.state, 'detail')
    runtime = closeWorkoutDetail(detail.runtime, guidedWorkoutPlanV2, nowMs + 1_000)
    assert.equal(runtime.state, 'paused')
    assert.equal(runtime.pauseReason, 'detail_return')
    assert.equal(getWorkoutSnapshot(runtime, guidedWorkoutPlanV2, nowMs + 3_000).segmentElapsedMs, 2_000)
    runtime = resumeWorkoutRuntime(runtime, nowMs + 4_000)
    nowMs += 4_000
  }
  assert.equal(runtime.completedCount, 0)
  assert.equal(getWorkoutSnapshot(runtime, guidedWorkoutPlanV2, nowMs).segmentElapsedMs, 2_000)
})

test('completion is terminal and repeated advances emit nothing', () => {
  const completed = advanceWorkoutRuntime(startedRuntime(), guidedWorkoutPlanV2, 882_000)
  const repeated = advanceWorkoutRuntime(completed.runtime, guidedWorkoutPlanV2, 1_000_000)
  assert.equal(repeated.runtime.state, 'completed')
  assert.equal(repeated.snapshot.plannedElapsedMs, 882_000)
  assert.equal(repeated.voiceEvents.length, 0)
  assert.equal(repeated.segmentChanged, false)
})

test('exit is terminal and late scheduler callbacks cannot complete the session', () => {
  const active = advanceWorkoutRuntime(startedRuntime(), guidedWorkoutPlanV2, 34_000).runtime
  const exited = exitWorkoutRuntime(active)
  const late = advanceWorkoutRuntime(exited, guidedWorkoutPlanV2, 1_000_000)
  assert.equal(late.runtime.state, 'exited')
  assert.equal(late.voiceEvents.length, 0)
})
