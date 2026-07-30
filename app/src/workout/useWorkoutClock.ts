import { useCallback, useEffect, useRef, useState } from 'react'
import {
  advanceWorkoutRuntime,
  closeWorkoutDetail,
  createWorkoutRuntime,
  enterWorkoutDetail,
  exitWorkoutRuntime,
  getWorkoutSnapshot,
  pauseWorkoutRuntime,
  resumeWorkoutRuntime,
  skipWorkoutSegment,
  startWorkoutRuntime,
  type PauseReason,
  type WorkoutAdvanceResult,
  type WorkoutClockSnapshotV2,
  type WorkoutPlanV2,
  type WorkoutRuntimeV2,
  type WorkoutVoiceEvent,
} from './runtime'

type WorkoutClockOptions = {
  onVoiceEvent: (event: WorkoutVoiceEvent) => void
  onSilence: () => void
  onComplete: (runtime: WorkoutRuntimeV2) => void
}

function createSessionId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `workout-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useWorkoutClock(plan: WorkoutPlanV2, options: WorkoutClockOptions) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [initialRuntime] = useState(() => createWorkoutRuntime(plan, createSessionId()))
  const runtimeRef = useRef(initialRuntime)
  const completionNotifiedRef = useRef(false)
  const animationFrameRef = useRef<number | null>(null)
  const [snapshot, setSnapshot] = useState<WorkoutClockSnapshotV2>(() => getWorkoutSnapshot(runtimeRef.current, plan, performance.now()))

  const publishRuntime = useCallback((runtime: WorkoutRuntimeV2, nowMs: number) => {
    runtimeRef.current = runtime
    const nextSnapshot = getWorkoutSnapshot(runtime, plan, nowMs)
    setSnapshot(nextSnapshot)
    if (runtime.state === 'completed' && !completionNotifiedRef.current) {
      completionNotifiedRef.current = true
      optionsRef.current.onSilence()
      optionsRef.current.onComplete(runtime)
    }
    return nextSnapshot
  }, [plan])

  const publishAdvance = useCallback((result: WorkoutAdvanceResult) => {
    runtimeRef.current = result.runtime
    if (result.segmentChanged) optionsRef.current.onSilence()
    setSnapshot(result.snapshot)
    for (const event of result.voiceEvents) optionsRef.current.onVoiceEvent(event)
    if (result.runtime.state === 'completed' && !completionNotifiedRef.current) {
      completionNotifiedRef.current = true
      optionsRef.current.onSilence()
      optionsRef.current.onComplete(result.runtime)
    }
  }, [])

  const start = useCallback(() => {
    const nowMs = performance.now()
    publishRuntime(startWorkoutRuntime(runtimeRef.current, plan, nowMs), nowMs)
  }, [plan, publishRuntime])

  const pause = useCallback((reason: Exclude<PauseReason, 'detail_return'> = 'manual') => {
    const nowMs = performance.now()
    const result = pauseWorkoutRuntime(runtimeRef.current, plan, nowMs, reason)
    optionsRef.current.onSilence()
    publishAdvance(result)
  }, [plan, publishAdvance])

  const resume = useCallback(() => {
    const nowMs = performance.now()
    publishRuntime(resumeWorkoutRuntime(runtimeRef.current, nowMs), nowMs)
  }, [publishRuntime])

  const openDetail = useCallback(() => {
    const nowMs = performance.now()
    const result = enterWorkoutDetail(runtimeRef.current, plan, nowMs)
    optionsRef.current.onSilence()
    publishAdvance(result)
  }, [plan, publishAdvance])

  const closeDetail = useCallback(() => {
    const nowMs = performance.now()
    optionsRef.current.onSilence()
    publishRuntime(closeWorkoutDetail(runtimeRef.current, plan, nowMs), nowMs)
  }, [plan, publishRuntime])

  const skip = useCallback(() => {
    const nowMs = performance.now()
    optionsRef.current.onSilence()
    publishAdvance(skipWorkoutSegment(runtimeRef.current, plan, nowMs))
  }, [plan, publishAdvance])

  const exit = useCallback(() => {
    const nowMs = performance.now()
    optionsRef.current.onSilence()
    publishRuntime(exitWorkoutRuntime(runtimeRef.current), nowMs)
  }, [publishRuntime])

  useEffect(() => {
    const running = snapshot.runtime.state === 'preparing' || snapshot.runtime.state === 'active' || snapshot.runtime.state === 'rest'
    if (!running) return undefined

    const frame = (nowMs: number) => {
      publishAdvance(advanceWorkoutRuntime(runtimeRef.current, plan, nowMs))
      const state = runtimeRef.current.state
      if (state === 'preparing' || state === 'active' || state === 'rest') animationFrameRef.current = window.requestAnimationFrame(frame)
    }
    animationFrameRef.current = window.requestAnimationFrame(frame)
    return () => {
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }, [plan, publishAdvance, snapshot.runtime.state])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') pause('background')
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [pause])

  useEffect(() => () => {
    optionsRef.current.onSilence()
  }, [])

  return { snapshot, start, pause, resume, openDetail, closeDetail, skip, exit }
}
