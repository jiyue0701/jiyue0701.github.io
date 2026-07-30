import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  Barbell,
  CalendarDots,
  CaretLeft,
  CaretRight,
  Check,
  Clock,
  DeviceMobile,
  DownloadSimple,
  House,
  Info,
  ListChecks,
  Sparkle,
  Target,
  UserCircle,
} from '@phosphor-icons/react'
import { characterAssets, voiceChoices } from './data/character'
import { motionById } from './data/motion'
import { exerciseCatalog, planPresets, todayPlan } from './data/plan'
import { storage } from './lib/storage'
import { guidedWorkoutPlanV2, type WorkoutExerciseV2, type WorkoutRuntimeV2, type WorkoutVoiceEvent } from './workout/runtime'
import { createWorkoutCompletionRecord, isCompatibleCompletedSession, upsertCompletionHistory, type CompatibleCompletedSession } from './workout/session'
import { createCompletedSessionV2, projectCompletedSessionV2, upsertStoredCompletedSessionV2 } from './workout/completed-session-v2'
import { importWorkoutBackupV2, serializeWorkoutBackupV2 } from './workout/backup-v2'
import { executeWorkoutAppMutationV2, hydrateStoredPlanV2, projectWorkoutPlanStateForUiV2, type WorkoutAppMutationCommandV2 } from './workout/app-persistence-v2'
import { refreshWorkoutPlanStateV2 } from './workout/plan-migration-v2'
import { loadOrMigrateWorkoutDataV2 } from './workout/workout-data-v2'
import { useWorkoutClock } from './workout/useWorkoutClock'
import type { LocalWorkoutStateV2 } from './workout/contracts-v2'
import type { CompletedSession, Exercise, Screen, Tab, TrainingPlan, VoiceChoice } from './types'

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
type AudioStatus = 'idle' | 'ready' | 'blocked'
type PwaInstallState = 'installed' | 'installable' | 'ios-guide' | 'browser-guide'
type NavigatorWithStandalone = Navigator & { standalone?: boolean }
type PlanUiState = {
  editorOpen: boolean
  muscleFilter: '全部' | string
  equipmentFilter: '全部' | Exercise['equipment']
}

function isRunningInstalledApp() {
  return window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as NavigatorWithStandalone).standalone)
}

function isIosBrowser() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

const tabLabels: Record<Tab, string> = { home: '首页', plan: '计划', calendar: '日历', profile: '我的' }
const tabIconComponents = { home: House, plan: ListChecks, calendar: CalendarDots, profile: UserCircle }
const workoutPlanUiContext = { defaultPlan: todayPlan, exerciseCatalog }
let activeCueAudio: HTMLAudioElement | null = null
let trainingCueAudio: HTMLAudioElement | null = null
const cueText = ''

function createPersonalPlanId(prefix: string) {
  const suffix = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${suffix}`
}

function hydrateStoredPlan(plan: TrainingPlan) {
  return hydrateStoredPlanV2(plan, workoutPlanUiContext)
}

// 训练页不再播放整句开场/动作解析口令。保留兼容签名，避免旧数据或旧组件引用时重新触发长语音。
function speakCue(_choice: VoiceChoice, _text = '', _useAsset = true, _fallbackUri?: string) {}

function stopActiveCueAudio() {
  activeCueAudio?.pause()
  if (activeCueAudio) activeCueAudio.currentTime = 0
  activeCueAudio = null
}

function getTrainingCueAudio() {
  if (!trainingCueAudio) {
    trainingCueAudio = new Audio()
    trainingCueAudio.preload = 'auto'
    trainingCueAudio.setAttribute('playsinline', '')
  }
  return trainingCueAudio
}

function primeTrainingAudio() {
  for (let value = 1; value <= 12; value += 1) {
    const padded = String(value).padStart(2, '0')
    for (const uri of [`/media/audio/count-low-${padded}.wav`, `/media/audio/count-low-${padded}-v2.wav`]) {
      const audio = new Audio(uri)
      audio.preload = 'auto'
      audio.load()
    }
  }
}

function speakRepCount(choice: VoiceChoice, count: number, uri?: string, variants: string[] = [], variantIndex = 0, onStatusChange?: (status: AudioStatus) => void) {
  const sources = [uri, ...variants].filter((value): value is string => Boolean(value))
  const selectedUri = sources.length ? sources[variantIndex % sources.length] : undefined
  if (selectedUri) {
    const audio = getTrainingCueAudio()
    audio.pause()
    audio.src = selectedUri
    audio.currentTime = 0
    audio.playbackRate = choice.playbackRate ?? 1
    activeCueAudio = audio
    audio.onplay = () => onStatusChange?.('ready')
    audio.onended = () => { if (activeCueAudio === audio) activeCueAudio = null }
    audio.onerror = () => {
      if (activeCueAudio === audio) activeCueAudio = null
      onStatusChange?.('blocked')
    }
    void audio.play().catch(() => audio.onerror?.(new Event('error')))
  }
}

function speakWorkoutNumber(choice: VoiceChoice, event: WorkoutVoiceEvent, onStatusChange: (status: AudioStatus) => void) {
  const padded = String(event.value).padStart(2, '0')
  speakRepCount(
    choice,
    event.value,
    `/media/audio/count-low-${padded}.wav`,
    [`/media/audio/count-low-${padded}-v2.wav`],
    event.variantIndex,
    onStatusChange,
  )
}

async function unlockTrainingAudio(choice: VoiceChoice) {
  if (!choice.audioUri) return false
  const audio = getTrainingCueAudio()
  audio.src = choice.audioUri
  audio.preload = 'auto'
  audio.volume = 0.01
  audio.playbackRate = choice.playbackRate ?? 1
  try {
    await audio.play()
    audio.pause()
    audio.currentTime = 0
    audio.volume = 1
    primeTrainingAudio()
    return true
  } catch {
    audio.volume = 1
    return false
  }
}

function formatDate(dateString?: string) {
  if (!dateString) return '还没有训练记录'
  return `${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(dateString))} 已完成`
}

function projectWorkoutDataForUi(state: LocalWorkoutStateV2) {
  const legacySessions = state.legacySessions.map((entry) => entry.data).filter(isCompatibleCompletedSession)
  const v2Sessions = state.sessions.map(projectCompletedSessionV2)
  const sessions = [...legacySessions, ...v2Sessions].sort((a, b) => a.completedAt.localeCompare(b.completedAt))
  let lastSession: CompatibleCompletedSession | null = null
  const lastSessionRef = state.lastSessionRef
  if (lastSessionRef?.kind === 'v2') {
    const record = state.sessions.find((session) => session.sessionId === lastSessionRef.sessionId)
    if (record) lastSession = projectCompletedSessionV2(record)
  } else if (lastSessionRef?.kind === 'legacy') {
    const record = state.legacySessions.find((session) => session.legacyId === lastSessionRef.legacyId)?.data
    if (isCompatibleCompletedSession(record)) lastSession = record
  }
  lastSession ??= sessions[sessions.length - 1] ?? null
  const planState = projectWorkoutPlanStateForUiV2(state, workoutPlanUiContext)
  return { sessions, lastSession, savedPlans: planState.savedPlans, activePlan: planState.activePlan }
}

function App() {
  const shortcutView = new URLSearchParams(window.location.search).get('view')
  const initialTab: Tab = shortcutView === 'plan' ? 'plan' : shortcutView === 'calendar' ? 'calendar' : shortcutView === 'profile' ? 'profile' : 'home'
  const [activeTab, setActiveTab] = useState<Tab>(initialTab)
  const [screen, setScreen] = useState<Screen>(initialTab)
  const [activePlan, setActivePlan] = useState<TrainingPlan>(todayPlan)
  const [selectedIds, setSelectedIds] = useState<string[]>(todayPlan.exercises.map((exercise) => exercise.id))
  const [selectedRounds, setSelectedRounds] = useState(todayPlan.rounds)
  const [detailExercise, setDetailExercise] = useState<Exercise | null>(null)
  const [lastSession, setLastSession] = useState<CompatibleCompletedSession | null>(null)
  const [sessions, setSessions] = useState<CompatibleCompletedSession[]>([])
  const [savedPlans, setSavedPlans] = useState<TrainingPlan[]>([])
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const [selectedVoice, setSelectedVoice] = useState<VoiceChoice>(voiceChoices[0])
  const [audioStatus, setAudioStatus] = useState<AudioStatus>('idle')
  const [detailReturnScreen, setDetailReturnScreen] = useState<Screen>('plan')
  const [workoutDetailOpen, setWorkoutDetailOpen] = useState(false)
  const [storageReady, setStorageReady] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [appInstalled, setAppInstalled] = useState(isRunningInstalledApp)
  const [iosBrowser] = useState(isIosBrowser)
  const [notice, setNotice] = useState('')
  const [planUi, setPlanUi] = useState<PlanUiState>({ editorOpen: initialTab === 'plan' && activePlan.id === 'personal-draft', muscleFilter: '全部', equipmentFilter: '全部' })
  const pendingScreenRestore = useRef<{ screen: Screen; top: number; focusId?: string | null; focusHeading?: boolean } | null>(null)
  const screenScrollPositions = useRef<Partial<Record<Screen, number>>>({})
  const detailOpenerId = useRef<string | null>(null)
  const bottomStackRef = useRef<HTMLDivElement>(null)
  const workoutDataV2Ref = useRef<LocalWorkoutStateV2 | null>(null)
  const completionTimestampBySessionRef = useRef(new Map<string, string>())

  useEffect(() => {
    void loadOrMigrateWorkoutDataV2(storage, { completedAt: new Date().toISOString(), knownVoiceIds: voiceChoices.map((choice) => choice.id) }).then(({ state }) => {
      workoutDataV2Ref.current = state
      const projected = projectWorkoutDataForUi(state)
      setLastSession(projected.lastSession)
      setSessions(projected.sessions)
      setSavedPlans(projected.savedPlans)
      setActivePlan(projected.activePlan)
      setSelectedIds(projected.activePlan.exercises.map((exercise) => exercise.id))
      setSelectedRounds(projected.activePlan.rounds)
      setEditingPlanId(projected.activePlan.source === 'personal' ? projected.activePlan.id : null)
      if (state.selectedVoiceId) setSelectedVoice(voiceChoices.find((choice) => choice.id === state.selectedVoiceId) ?? voiceChoices[0])
      setStorageReady(true)
    }).catch((error) => {
      console.error('workout-data-v2 initialization failed', error)
      setStorageReady(true)
    })

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault()
      if (!isRunningInstalledApp()) setInstallPrompt(event as InstallPromptEvent)
    }
    const displayMode = window.matchMedia('(display-mode: standalone)')
    const syncInstalledState = () => setAppInstalled(isRunningInstalledApp())
    const handleAppInstalled = () => {
      setAppInstalled(true)
      setInstallPrompt(null)
    }
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)
    window.addEventListener('pageshow', syncInstalledState)
    displayMode.addEventListener('change', syncInstalledState)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
      window.removeEventListener('pageshow', syncInstalledState)
      displayMode.removeEventListener('change', syncInstalledState)
    }
  }, [])

  useEffect(() => {
    if (notice) {
      const timer = window.setTimeout(() => setNotice(''), 3200)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [notice])

  useEffect(() => {
    const pending = pendingScreenRestore.current
    if (!pending || pending.screen !== screen) return
    pendingScreenRestore.current = null
    const { top, focusId, focusHeading } = pending
    const restore = () => {
      if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true })
      if (focusHeading) document.querySelector<HTMLElement>('.page-header h1')?.focus({ preventScroll: true })
      window.scrollTo({ top, left: 0, behavior: 'auto' })
    }
    window.requestAnimationFrame(() => {
      restore()
      window.requestAnimationFrame(() => {
        restore()
        window.setTimeout(restore, 0)
      })
    })
  }, [screen])

  const commitPlanMutation = (
    command: WorkoutAppMutationCommandV2,
    successNotice: string,
    afterCommitted?: () => void,
  ) => executeWorkoutAppMutationV2({
    adapter: storage,
    command,
    migratedAt: new Date().toISOString(),
    knownVoiceIds: voiceChoices.map((choice) => choice.id),
    planUiContext: workoutPlanUiContext,
    successNotice,
    setNotice,
    onCommitted: ({ state, snapshot }) => {
      workoutDataV2Ref.current = state
      setActivePlan(snapshot.activePlan)
      setSavedPlans(snapshot.savedPlans)
      setSelectedIds(snapshot.activePlan.exercises.map((exercise) => exercise.id))
      setSelectedRounds(snapshot.activePlan.rounds)
      setEditingPlanId(snapshot.activePlan.source === 'personal' && snapshot.activePlan.id !== 'personal-draft' ? snapshot.activePlan.id : null)
      afterCommitted?.()
    },
    onError: (error) => console.error('workout-data-v2 plan persistence failed', error),
  })

  useEffect(() => {
    const stack = bottomStackRef.current
    if (!stack) return undefined
    const updateHeight = () => document.documentElement.style.setProperty('--bottom-stack-height', `${Math.ceil(stack.getBoundingClientRect().height)}px`)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(stack)
    return () => observer.disconnect()
  }, [screen, planUi.editorOpen])

  useEffect(() => {
    if (screen !== 'workout') return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [screen])

  const chooseVoice = async (choice: VoiceChoice) => executeWorkoutAppMutationV2({
    adapter: storage,
    command: { type: 'select_voice', voiceId: choice.id },
    migratedAt: new Date().toISOString(),
    knownVoiceIds: voiceChoices.map((voice) => voice.id),
    planUiContext: workoutPlanUiContext,
    successNotice: '',
    setNotice,
    onCommitted: ({ state }) => {
      workoutDataV2Ref.current = state
      setSelectedVoice(choice)
    },
    onError: (error) => console.error('workout-data-v2 voice persistence failed', error),
  })

  const enableTrainingAudio = async () => {
    const ready = await unlockTrainingAudio(selectedVoice)
    setAudioStatus(ready ? 'ready' : 'blocked')
    if (!ready) setNotice('声音尚未开启，请在训练页点“开启计数声音”重试')
  }

  const startWorkout = (exercise?: Exercise) => {
    void exercise
    setWorkoutDetailOpen(false)
    setAudioStatus('idle')
    void enableTrainingAudio()
    setScreen('workout')
  }

  const completeWorkout = (runtime: WorkoutRuntimeV2) => {
    const completedAt = completionTimestampBySessionRef.current.get(runtime.sessionId) ?? new Date().toISOString()
    completionTimestampBySessionRef.current.set(runtime.sessionId, completedAt)
    const session = createWorkoutCompletionRecord(runtime, guidedWorkoutPlanV2, {
      completedAt,
      estimatedCalories: todayPlan.estimatedCalories,
    })
    const sessionV2 = createCompletedSessionV2({ runtime, plan: guidedWorkoutPlanV2, completedAt, estimatedCalories: todayPlan.estimatedCalories })
    setLastSession((previous) => upsertCompletionHistory(previous ? [previous] : [], session, 1).record)
    setSessions((history) => upsertCompletionHistory(history, session).history)
    setScreen('complete')
    void upsertStoredCompletedSessionV2(storage, sessionV2, async () => workoutDataV2Ref.current ?? (await loadOrMigrateWorkoutDataV2(storage, { completedAt, knownVoiceIds: voiceChoices.map((choice) => choice.id) })).state).then((result) => {
      workoutDataV2Ref.current = result.state
      const projected = projectWorkoutDataForUi(result.state)
      setLastSession(projected.lastSession)
      setSessions(projected.sessions)
    }).catch(() => {
      setNotice('训练已完成，但本机记录暂时无法写入；当前页面仍保留本次结果。')
    })
  }

  const goToTab = (tab: Tab) => {
    if (screen === tab && activeTab === tab) {
      screenScrollPositions.current[tab] = 0
      window.scrollTo({ top: 0, left: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.page-header h1')?.focus({ preventScroll: true }))
      return
    }
    if (screen === 'home' || screen === 'plan' || screen === 'calendar' || screen === 'profile') screenScrollPositions.current[screen] = window.scrollY
    pendingScreenRestore.current = { screen: tab, top: screenScrollPositions.current[tab] ?? 0, focusHeading: true }
    setActiveTab(tab)
    setScreen(tab)
  }

  const openDetail = (exercise: Exercise, openerId?: string) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    detailOpenerId.current = openerId || opener?.id || null
    screenScrollPositions.current[screen] = window.scrollY
    setDetailReturnScreen(screen)
    setDetailExercise(exercise)
    if (screen === 'workout') {
      stopActiveCueAudio()
      setWorkoutDetailOpen(true)
      return
    }
    setScreen('detail')
  }

  const closeDetail = () => {
    if (workoutDetailOpen) {
      const openerId = detailOpenerId.current
      setWorkoutDetailOpen(false)
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (openerId) document.getElementById(openerId)?.focus({ preventScroll: true })
      }))
      return
    }
    const target = detailReturnScreen === 'detail' || detailReturnScreen === 'complete' ? 'plan' : detailReturnScreen
    pendingScreenRestore.current = { screen: target, top: target === 'workout' ? 0 : (screenScrollPositions.current[target] ?? 0), focusId: detailOpenerId.current }
    if (target === 'home' || target === 'plan' || target === 'calendar' || target === 'profile') setActiveTab(target)
    setScreen(target)
  }

  const generatePersonalPlan = async () => {
    const exercises = exerciseCatalog.filter((exercise) => selectedIds.includes(exercise.id))
    if (!exercises.length) {
      setNotice('至少选择一个动作，再生成个人计划')
      return false
    }
    const existingPlan = editingPlanId ? savedPlans.find((item) => item.id === editingPlanId) : null
    const plan: TrainingPlan = {
      id: editingPlanId ?? createPersonalPlanId('personal'),
      title: '我的个人计划',
      subtitle: `自选 ${exercises.length} 个动作 · ${selectedRounds} 轮`,
      duration: Math.max(5, Math.round(exercises.length * selectedRounds * 1.9)),
      rounds: selectedRounds,
      estimatedCalories: Math.round(exercises.length * selectedRounds * 12),
      source: 'personal',
      exercises,
    }
    if (existingPlan) plan.title = existingPlan.title
    const result = await commitPlanMutation(
      { type: 'save_plan', plan },
      '个人计划已保存；当前仅保存，暂不参与跟练',
      () => setPlanUi((current) => ({ ...current, editorOpen: false })),
    )
    return result.ok
  }

  const applyPlan = async (plan: TrainingPlan) => (
    await commitPlanMutation({ type: 'apply_plan', planId: plan.id }, `已切换到「${plan.title}」`)
  ).ok

  const addPlanToLibrary = async (plan: TrainingPlan, successNotice = `已添加「${plan.title}」到我的计划库，可继续修改或删除`) => {
    const hydratedPlan = hydrateStoredPlan(plan)
    const libraryPlan: TrainingPlan = {
      ...hydratedPlan,
      id: createPersonalPlanId(`library-${plan.id}`),
      source: 'personal',
    }
    const result = await commitPlanMutation({ type: 'save_plan', plan: libraryPlan }, successNotice)
    return result.ok ? libraryPlan : null
  }

  const addPresetToLibrary = async (plan: TrainingPlan) => { await addPlanToLibrary(plan) }

  const editCurrentPlan = async () => {
    if (activePlan.source === 'preset') {
      const copied = await addPlanToLibrary(activePlan, '已复制到我的计划库，现在可以修改动作、轮次或名称')
      if (!copied) return false
      setActiveTab('plan')
      setScreen('plan')
      return true
    }
    setSelectedIds(activePlan.exercises.map((exercise) => exercise.id))
    setSelectedRounds(activePlan.rounds)
    setEditingPlanId(activePlan.source === 'personal' && activePlan.id !== 'personal-draft' ? activePlan.id : null)
    setActiveTab('plan')
    setScreen('plan')
    return true
  }

  const createNewPlan = () => {
    setActivePlan({ id: 'personal-draft', title: '新建个人计划', subtitle: '按肌群选择动作，保存后即可套用。', duration: 0, rounds: 2, estimatedCalories: 0, source: 'personal', exercises: [] })
    setSelectedIds([])
    setSelectedRounds(2)
    setEditingPlanId(null)
    setActiveTab('plan')
    setScreen('plan')
    setNotice('已打开新计划，按肌群选择动作后保存。')
    return true
  }

  const renamePlan = async (planId: string) => {
    const plan = savedPlans.find((item) => item.id === planId)
    if (!plan) return
    const nextTitle = window.prompt('给这个计划改个名字', plan.title)?.trim()
    if (!nextTitle || nextTitle === plan.title) return
    await commitPlanMutation({ type: 'rename_plan', planId, title: nextTitle }, `计划已改名为「${nextTitle}」`)
  }

  const deletePlan = async (planId: string) => {
    const plan = savedPlans.find((item) => item.id === planId)
    if (!plan) return
    if (!window.confirm(`删除「${plan.title}」？训练记录不会受到影响。`)) return
    await commitPlanMutation({ type: 'delete_plan', planId }, '计划已删除，已切回默认训练计划')
  }

  const exportBackup = async () => {
    try {
      const exportedAt = new Date().toISOString()
      const current = workoutDataV2Ref.current ?? (await loadOrMigrateWorkoutDataV2(storage, { completedAt: exportedAt, knownVoiceIds: voiceChoices.map((choice) => choice.id) })).state
      const refreshed = refreshWorkoutPlanStateV2(current, { activePlan, savedPlans, selectedVoiceId: selectedVoice.id }, { migratedAt: exportedAt, knownVoiceIds: voiceChoices.map((choice) => choice.id) })
      const blob = new Blob([serializeWorkoutBackupV2(refreshed.state, exportedAt)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `训练教练备份-${exportedAt.slice(0, 10)}.json`
      link.click()
      URL.revokeObjectURL(url)
      setNotice('备份文件已导出，请保存到安全位置')
    } catch {
      setNotice('备份文件无法读取，请选择训练教练导出的 JSON 文件')
    }
  }

  const importBackup = async (file: File) => {
    try {
      const imported = await importWorkoutBackupV2(storage, await file.text(), { importedAt: new Date().toISOString(), knownVoiceIds: voiceChoices.map((choice) => choice.id) })
      workoutDataV2Ref.current = imported.state
      const projected = projectWorkoutDataForUi(imported.state)
      setActivePlan(projected.activePlan)
      setSelectedIds(projected.activePlan.exercises.map((exercise) => exercise.id))
      setSelectedRounds(projected.activePlan.rounds)
      setSavedPlans(projected.savedPlans)
      setSessions(projected.sessions)
      setLastSession(projected.lastSession)
      if (imported.state.selectedVoiceId) setSelectedVoice(voiceChoices.find((choice) => choice.id === imported.state.selectedVoiceId) ?? voiceChoices[0])
      setNotice('备份已恢复，计划和训练记录都已载入')
    } catch {
      setNotice('备份文件无法读取，请选择训练教练导出的 JSON 文件')
    }
  }

  const installApp = async () => {
    if (appInstalled) {
      setNotice('应用已经安装，当前无需重复操作')
      return
    }
    if (!installPrompt) {
      setNotice(iosBrowser ? '请在 Safari 点“分享”，再选择“添加到主屏幕”' : '请在浏览器菜单中选择“安装应用”或“创建快捷方式”')
      return
    }
    try {
      await installPrompt.prompt()
      const choice = await installPrompt.userChoice
      setInstallPrompt(null)
      if (choice.outcome === 'dismissed') setNotice('已取消安装，之后仍可从“我的”页面重新尝试')
    } catch {
      setInstallPrompt(null)
      setNotice('暂时无法调起安装，请使用浏览器菜单完成安装')
    }
  }

  return (
    <div className="app-shell">
      <main className="app-main">
        {screen === 'workout' ? (
          <>
            <div className="workout-layer" inert={workoutDetailOpen} aria-hidden={workoutDetailOpen}>
              <WorkoutScreenModal
                selectedVoice={selectedVoice}
                audioStatus={audioStatus}
                detailOpen={workoutDetailOpen}
                onEnableAudio={() => { void enableTrainingAudio() }}
                onAudioStatusChange={setAudioStatus}
                onComplete={completeWorkout}
                onExit={() => {
                  stopActiveCueAudio()
                  goToTab('home')
                }}
                onOpenDetail={openDetail}
              />
            </div>
            {workoutDetailOpen && detailExercise && <WorkoutDetailOverlay exercise={detailExercise} onClose={closeDetail} />}
          </>
        ) : screen === 'complete' ? (
          <CompleteScreen session={lastSession} totalExercises={guidedWorkoutPlanV2.exercises.length} onStart={() => startWorkout()} onBackHome={() => goToTab('home')} />
        ) : screen === 'detail' && detailExercise ? (
          <DetailScreen exercise={detailExercise} backLabel="返回" onBack={closeDetail} onStart={() => startWorkout(detailExercise)} />
        ) : screen === 'plan' ? (
          <PlanScreen activePlan={activePlan} savedPlans={savedPlans} editingPlanId={editingPlanId} selectedIds={selectedIds} selectedRounds={selectedRounds} planUi={planUi} onPlanUiChange={setPlanUi} onToggle={(id) => setSelectedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id])} onRoundsChange={setSelectedRounds} onGenerate={generatePersonalPlan} onAddPreset={addPresetToLibrary} onApplyPlan={applyPlan} onEditCurrent={editCurrentPlan} onCreateNew={createNewPlan} onRenamePlan={renamePlan} onDeletePlan={deletePlan} onOpenDetail={openDetail} />
        ) : screen === 'calendar' ? (
          <CalendarScreen sessions={sessions} onStart={() => startWorkout()} />
        ) : screen === 'profile' ? (
          <ProfileScreen lastSession={lastSession} storageReady={storageReady} installState={appInstalled ? 'installed' : installPrompt ? 'installable' : iosBrowser ? 'ios-guide' : 'browser-guide'} onInstall={installApp} onExportBackup={exportBackup} onImportBackup={importBackup} />
        ) : (
          <HomeScreen activePlan={todayPlan} lastSession={lastSession} onStart={() => startWorkout()} onOpenPlan={() => goToTab('plan')} onOpenDetail={openDetail} />
        )}
      </main>
      {screen !== 'workout' && screen !== 'detail' && <div className={`mobile-bottom-stack ${screen === 'plan' ? 'mobile-bottom-stack--with-action' : ''}`} ref={bottomStackRef}>{screen === 'plan' && <PlanActionDock editorOpen={planUi.editorOpen} disabled={planUi.editorOpen ? !selectedIds.length : false} onSave={generatePersonalPlan} onStart={() => startWorkout()} />}<BottomNav activeTab={activeTab} onChange={goToTab} /></div>}
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  )
}

function PageHeader({ eyebrow, title, right }: { eyebrow?: string; title: string; right?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1 tabIndex={-1}>{title}</h1></div>{right}</header>
}

function HomeScreen({ activePlan, lastSession, onStart, onOpenPlan, onOpenDetail }: { activePlan: TrainingPlan; lastSession: CompletedSession | null; onStart: () => void; onOpenPlan: () => void; onOpenDetail: (exercise: Exercise, openerId?: string) => void }) {
  const previewExercises = activePlan.exercises.slice(0, 3)
  return <div className="page page-home">
    <PageHeader eyebrow="今天也留一点时间给自己" title="跟着教练，稳稳练起来" right={<div className="avatar avatar--logo" aria-label="教练"><img src="/icon-192.png" alt="" /></div>} />
    <section className="hero-card hero-card--media">
      <img src={characterAssets.actionPosterUri} alt="教练在健身房示范高脚杯深蹲" />
      <div className="hero-card__overlay" />
      <div className="hero-card__copy"><span className="soft-label">TODAY'S FOCUS</span><h2>{activePlan.title}</h2><p>{activePlan.subtitle}</p><div className="hero-meta"><span><Clock size={15} aria-hidden="true" />约 {activePlan.duration} 分钟</span><span><Barbell size={15} aria-hidden="true" />{activePlan.exercises.length} 个动作</span></div></div>
      <span className="lock-chip">今日教练</span>
    </section>
    <button className="primary-button home-start-button" onClick={onStart}><span>开始 15 分钟跟练</span><ArrowRight size={20} aria-hidden="true" /></button>
    <section className="section-heading"><div><p className="eyebrow">当前计划</p><h2>{activePlan.title}</h2></div><button className="text-link" onClick={onOpenPlan}>调整计划</button></section>
    <div className="exercise-preview-list">{previewExercises.map((exercise, index) => <ExerciseRow key={exercise.id} exercise={exercise} index={index} onOpen={onOpenDetail} />)}</div>
    {activePlan.exercises.length > previewExercises.length && <button className="preview-more" onClick={onOpenPlan}>查看全部 {activePlan.exercises.length} 个动作</button>}
    <p className="last-session-note">{lastSession ? `上次训练：${formatDate(lastSession.completedAt)}` : '完成训练后，记录只保存在本机'}</p>
  </div>
}

const muscleGroupOrder = ['胸部', '背部', '肩部', '手臂', '核心', '髋稳定', '臀大肌', '股四头肌', '腘绳肌', '小腿', '下肢稳定']
const legacyMuscleGroupsByExercise: Record<string, string[]> = {
  'goblet-squat': ['股四头肌', '臀大肌'],
  'romanian-deadlift': ['腘绳肌', '臀大肌'],
  'reverse-lunge': ['股四头肌', '臀大肌'],
  'glute-bridge': ['臀大肌', '腘绳肌'],
  'bodyweight-squat': ['股四头肌', '臀大肌'],
  'bodyweight-glute-bridge': ['臀大肌', '腘绳肌'],
  'chair-sit-to-stand': ['股四头肌', '臀大肌'],
  'chair-assisted-split-squat': ['下肢稳定', '股四头肌', '臀大肌'],
  'dumbbell-reverse-lunge': ['股四头肌', '臀大肌'],
}

function getMuscleGroups(exercise: Exercise) {
  if (exercise.muscleGroups?.length) return exercise.muscleGroups
  if (legacyMuscleGroupsByExercise[exercise.id]) return legacyMuscleGroupsByExercise[exercise.id]
  const target = exercise.target
  const groups = muscleGroupOrder.filter((group) => target.includes(group))
  if (target.includes('臀部') && !groups.includes('臀大肌')) groups.push('臀大肌')
  if (target.includes('大腿') && !groups.includes('股四头肌')) groups.push('股四头肌')
  if (!groups.length) groups.push('下肢稳定')
  return groups
}

function PlanScreen({ activePlan, savedPlans, editingPlanId, selectedIds, selectedRounds, planUi, onPlanUiChange, onToggle, onRoundsChange, onGenerate, onAddPreset, onApplyPlan, onEditCurrent, onCreateNew, onRenamePlan, onDeletePlan, onOpenDetail }: { activePlan: TrainingPlan; savedPlans: TrainingPlan[]; editingPlanId: string | null; selectedIds: string[]; selectedRounds: number; planUi: PlanUiState; onPlanUiChange: (value: PlanUiState | ((current: PlanUiState) => PlanUiState)) => void; onToggle: (id: string) => void; onRoundsChange: (rounds: number) => void; onGenerate: () => void; onAddPreset: (plan: TrainingPlan) => void; onApplyPlan: (plan: TrainingPlan) => Promise<boolean>; onEditCurrent: () => Promise<boolean>; onCreateNew: () => boolean; onRenamePlan: (planId: string) => void; onDeletePlan: (planId: string) => void; onOpenDetail: (exercise: Exercise, openerId?: string) => void }) {
  const { editorOpen, muscleFilter, equipmentFilter } = planUi
  const editorTitleRef = useRef<HTMLHeadingElement>(null)
  const revealEditor = async (prepare: () => boolean | Promise<boolean>) => {
    if (!await prepare()) return
    onPlanUiChange((current) => ({ ...current, editorOpen: true }))
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const title = editorTitleRef.current
      if (!title) return
      title.focus({ preventScroll: true })
      title.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }))
  }
  const visibleExercises = exerciseCatalog.filter((exercise) => {
    const matchesMuscle = muscleFilter === '全部' || getMuscleGroups(exercise).includes(muscleFilter)
    const matchesEquipment = equipmentFilter === '全部' || exercise.equipment === equipmentFilter
    return matchesMuscle && matchesEquipment
  })
  const groupedExercises = (muscleFilter === '全部' ? muscleGroupOrder : [muscleFilter])
    .map((group) => ({
      group,
      exercises: visibleExercises.filter((exercise) => muscleFilter === '全部'
        ? getMuscleGroups(exercise)[0] === group
        : getMuscleGroups(exercise).includes(group)),
    }))
    .filter((section) => section.exercises.length)
  return <div className="page page-plan">
    <PageHeader eyebrow="先选目标，再开始训练" title="训练计划" />
    <section className="plan-summary"><div className="plan-summary__top"><span className="soft-label">CURRENT PLAN</span><span className="status-dot">{activePlan.source === 'personal' ? '个人计划' : '已准备'}</span></div><h2>{activePlan.title}</h2><p>{activePlan.subtitle}</p><div className="plan-stats"><div><strong>{activePlan.exercises.length}</strong><span>个动作</span></div><div><strong>{activePlan.duration}<span>min</span></strong><span>预计时长</span></div><div><strong>{activePlan.rounds}</strong><span>默认轮次</span></div></div></section>
    <div className="plan-edit-actions"><button className="secondary-button" aria-expanded={editorOpen} aria-controls="plan-editor" onClick={() => revealEditor(onEditCurrent)}>修改当前计划</button><button className="secondary-button" aria-expanded={editorOpen} aria-controls="plan-editor" onClick={() => revealEditor(onCreateNew)}>新建个人计划</button></div>
    {activePlan.source === 'personal' && activePlan.id !== 'personal-draft' && <div className="active-plan-tools"><span>当前是已保存的个人计划</span><div><button onClick={() => onRenamePlan(activePlan.id)}>改名</button><button className="danger-link" onClick={() => onDeletePlan(activePlan.id)}>删除</button></div></div>}
    {editorOpen ? <section id="plan-editor" className="plan-editor" aria-labelledby="plan-editor-title">
      <div className="section-heading section-heading--compact"><div><p className="eyebrow">个人计划 · 两层筛选</p><h2 id="plan-editor-title" ref={editorTitleRef} tabIndex={-1}>选择对应动作</h2></div><output className="round-badge" role="status" aria-live="polite">{selectedIds.length} 个已选</output></div>
      <p className="plan-editor-note"><Info size={18} aria-hidden="true" /><span><strong>当前仅保存，暂不参与跟练</strong><small>训练入口始终使用固定 v2「15 分钟臀腿跟练」。</small></span></p>
      <div className="filter-stack"><div className="filter-row" role="group" aria-label="选择肌群"><span>选择肌群</span><div className="muscle-filter">{(['全部', ...muscleGroupOrder] as const).map((group) => <button key={group} className={muscleFilter === group ? 'selected' : ''} aria-pressed={muscleFilter === group} onClick={() => onPlanUiChange((current) => ({ ...current, muscleFilter: group }))}>{group}</button>)}</div></div><div className="filter-row" role="group" aria-label="选择器械"><span>选择器械</span><div className="equipment-filter">{(['全部', '徒手', '椅子辅助', '哑铃'] as const).map((equipment) => <button key={equipment} className={equipmentFilter === equipment ? 'selected' : ''} aria-pressed={equipmentFilter === equipment} onClick={() => onPlanUiChange((current) => ({ ...current, equipmentFilter: equipment }))}>{equipment}</button>)}</div></div></div>
      <div className="exercise-groups">{groupedExercises.map(({ group, exercises }) => <section className="muscle-group" key={group}><div className="muscle-group__heading"><strong>{group}</strong><span>{exercises.length} 个动作</span></div><div className="exercise-select-list">{exercises.map((exercise) => { const detailId = `plan-exercise-detail-${exercise.id}`; return <div className="exercise-select-row" key={exercise.id}><button className={`exercise-select ${selectedIds.includes(exercise.id) ? 'selected' : ''}`} onClick={() => onToggle(exercise.id)} aria-pressed={selectedIds.includes(exercise.id)}><span className="exercise-check">{selectedIds.includes(exercise.id) && <Check size={15} weight="bold" aria-hidden="true" />}</span><span><strong>{exercise.name}</strong><small>{exercise.equipment} · {exercise.target} · {exercise.duration}</small></span></button><button id={detailId} className="exercise-info-button" onClick={() => onOpenDetail(exercise, detailId)} aria-label={`查看${exercise.name}动作详情`}><Info size={18} aria-hidden="true" /></button></div> })}</div></section>)}</div>
      <div className="round-picker" role="group" aria-label="选择轮次"><span>轮次</span><div>{[1, 2, 3].map((round) => <button key={round} className={selectedRounds === round ? 'selected' : ''} aria-pressed={selectedRounds === round} onClick={() => onRoundsChange(round)}>{round} 轮</button>)}</div></div>
    </section> : <>
      {savedPlans.length > 0 && <><section className="section-heading section-heading--compact"><div><p className="eyebrow">我的计划库</p><h2>已保存的训练</h2></div></section><div className="saved-plan-list">{savedPlans.map((plan) => <div className={`saved-plan-row ${activePlan.id === plan.id ? 'selected' : ''}`} key={plan.id}><div><strong>{plan.title}</strong><span>{plan.exercises.length} 个动作 · {plan.rounds} 轮</span></div><div className="saved-plan-row__actions"><button onClick={() => revealEditor(() => onApplyPlan(plan))}>编辑</button><button className="ghost-action" onClick={() => onRenamePlan(plan.id)} aria-label={`重命名${plan.title}`}>改名</button><button className="ghost-action danger-link" onClick={() => onDeletePlan(plan.id)} aria-label={`删除${plan.title}`}>删除</button></div></div>)}</div></>}
      <section className="section-heading section-heading--compact"><div><p className="eyebrow">更多健身计划</p><h2>添加后可修改或删除</h2></div></section>
      <div className="preset-grid">{planPresets.map((plan) => <button key={plan.id} className="preset-card" onClick={() => onAddPreset(plan)}><strong>{plan.title}</strong><span>{plan.duration} 分钟 · {plan.exercises.length} 个动作</span><em>添加到我的计划</em></button>)}</div>
    </>}
  </div>
}

function PlanActionDock({ editorOpen, disabled, onSave, onStart }: { editorOpen: boolean; disabled: boolean; onSave: () => void; onStart: () => void }) {
  return <div className="plan-action-dock"><button className="primary-button" onClick={editorOpen ? onSave : onStart} disabled={disabled}>{editorOpen ? <><span>保存个人计划</span><Check size={20} weight="bold" aria-hidden="true" /></> : <><span>开始 15 分钟跟练</span><ArrowRight size={20} aria-hidden="true" /></>}</button></div>
}

function ActionPoster({ exercise }: { exercise: Exercise }) {
  return <img className="action-poster-fallback" src="/media/actions/posters/standard-action-poster.svg" alt={`${exercise.name}动作海报`} />
}

function MotionPlayer({ workoutExercise, exercise, elapsedMs, paused, onReady }: { workoutExercise: WorkoutExerciseV2; exercise: Exercise; elapsedMs: number; paused: boolean; onReady?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const motion = motionById[`${workoutExercise.exerciseId}.v1`]
  const cycleDurationMs = workoutExercise.cycleDurationMs ?? workoutExercise.segmentDurationMs
  const cycleProgress = cycleDurationMs ? (elapsedMs % cycleDurationMs) / cycleDurationMs : 0
  const frameUris = motion.frameUris ?? []
  const frameIndex = frameUris.length ? Math.min(frameUris.length - 1, Math.floor(cycleProgress * frameUris.length)) : 0
  const videoUri = workoutExercise.videoUri
  const hasFormalVideo = Boolean(videoUri || workoutExercise.videoFallbackUri)

  useEffect(() => {
    const preloadUris = hasFormalVideo ? [workoutExercise.posterUri] : [workoutExercise.posterUri, ...frameUris]
    for (const uri of preloadUris) {
      const image = new Image()
      image.src = uri
    }
  }, [frameUris, hasFormalVideo, workoutExercise.posterUri])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (Number.isFinite(video.duration) && video.duration > 0 && cycleDurationMs > 0) {
      video.playbackRate = video.duration / (cycleDurationMs / 1000)
      const expectedMediaSeconds = cycleProgress * video.duration
      if (Math.abs(video.currentTime - expectedMediaSeconds) > 0.15) video.currentTime = expectedMediaSeconds
    }
  }, [cycleDurationMs, cycleProgress, workoutExercise.exerciseId])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (paused) video.pause()
    else void video.play().catch(() => undefined)
  }, [paused, workoutExercise.exerciseId])

  return <div className="motion-player">
    <div className="motion-player__video-slot">{hasFormalVideo ? <video ref={videoRef} poster={workoutExercise.posterUri} autoPlay={!paused} loop muted playsInline preload="auto" onCanPlay={onReady} onLoadedMetadata={onReady}><source src={videoUri} type="video/webm" />{workoutExercise.videoFallbackUri && <source src={workoutExercise.videoFallbackUri} type="video/mp4" />}</video> : frameUris.length ? <img src={paused ? workoutExercise.posterUri : frameUris[frameIndex]} alt={motion.accessibility.altText} /> : <img src={workoutExercise.posterUri} alt={`${exercise.name}动作示范`} />}</div>
  </div>
}

function WorkoutMediaPreloader({ exercises, onReady, onError }: { exercises: WorkoutExerciseV2[]; onReady: () => void; onError: () => void }) {
  const readyIds = useRef(new Set<string>())
  const [done, setDone] = useState(false)
  const markReady = (exerciseId: string) => {
    readyIds.current.add(exerciseId)
    if (readyIds.current.size === exercises.length) {
      setDone(true)
      onReady()
    }
  }
  if (done) return null
  return <div aria-hidden="true" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}>
    {exercises.map((exercise) => <video key={exercise.exerciseId} muted playsInline preload="auto" onCanPlay={() => markReady(exercise.exerciseId)} onError={onError}><source src={exercise.videoUri} type="video/webm" />{exercise.videoFallbackUri && <source src={exercise.videoFallbackUri} type="video/mp4" />}</video>)}
  </div>
}

function DetailNarration({ exercise }: { exercise: Exercise }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [audioState, setAudioState] = useState<'idle' | 'playing' | 'blocked'>('idle')
  const uri = exercise.media.coachingAudio?.tipUri

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !uri) return undefined
    audio.currentTime = 0
    void audio.play().then(() => setAudioState('playing')).catch(() => setAudioState('blocked'))
    return () => {
      audio.pause()
      audio.currentTime = 0
    }
  }, [uri])

  if (!uri) return null
  return <section className="detail-narration" aria-label="动作讲解语音"><div><strong>教练动作讲解</strong><small>{audioState === 'blocked' ? '浏览器阻止了自动播放，请点播放' : '进入详情后自动尝试播放'}</small></div><audio ref={audioRef} src={uri} controls preload="metadata" onPlay={() => setAudioState('playing')} onPause={() => setAudioState('idle')} onError={() => setAudioState('blocked')} /></section>
}

function DetailScreen({ exercise, backLabel, onBack, onStart, startLabel = '开始 15 分钟跟练', titleId = 'detail-title', cueId = 'detail-cue' }: { exercise: Exercise; backLabel: string; onBack: () => void; onStart: () => void; startLabel?: string; titleId?: string; cueId?: string }) {
  return <div className="page page-detail"><button className="back-link" onClick={onBack} autoFocus><CaretLeft size={18} aria-hidden="true" />{backLabel}</button><div className="detail-media">{exercise.media.videoUri ? <video src={exercise.media.videoUri} poster={exercise.media.posterUri} controls loop playsInline /> : exercise.media.posterUri ? <img src={exercise.media.posterUri} alt={`${exercise.name}动作海报`} /> : <ActionPoster exercise={exercise} />}<span className="detail-badge">动作解析</span></div><div className={`target-pill target-pill--${exercise.targetTone}`}>{exercise.target}</div><h1 id={titleId}>{exercise.name}</h1><p className="cue-line" id={cueId}>{exercise.cue}</p><DetailNarration exercise={exercise} /><section className="detail-section"><h2>动作步骤</h2><ol>{exercise.steps.map((step) => <li key={step}>{step}</li>)}</ol></section><section className="detail-section detail-section--soft"><h2>呼吸与提醒</h2><p><strong>呼吸：</strong>{exercise.breathing}</p><ul>{exercise.reminders.map((reminder) => <li key={reminder}>{reminder}</li>)}</ul></section><p className="detail-audio-note">训练中自动跟随动作节拍播放数字；完整动作要领和讲解语音在这里查看。</p><button className="primary-button sticky-action" onClick={onStart}><span>{startLabel}</span>{startLabel === '开始 15 分钟跟练' && <ArrowRight size={20} aria-hidden="true" />}</button></div>
}

function WorkoutDetailOverlay({ exercise, onClose }: { exercise: Exercise; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined
    const getFocusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute('hidden'))
    const focusFirst = () => getFocusable()[0]?.focus({ preventScroll: true })
    window.requestAnimationFrame(focusFirst)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = getFocusable()
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return <div ref={dialogRef} className="detail-overlay" role="dialog" aria-modal="true" aria-labelledby="workout-detail-title" aria-describedby="workout-detail-cue"><DetailScreen exercise={exercise} backLabel="返回训练" onBack={onClose} onStart={onClose} startLabel="返回训练" titleId="workout-detail-title" cueId="workout-detail-cue" /></div>
}

function WorkoutScreenModal({ selectedVoice, audioStatus, detailOpen, onEnableAudio, onAudioStatusChange, onComplete, onExit, onOpenDetail }: { selectedVoice: VoiceChoice; audioStatus: AudioStatus; detailOpen: boolean; onEnableAudio: () => void; onAudioStatusChange: (status: AudioStatus) => void; onComplete: (runtime: WorkoutRuntimeV2) => void; onExit: () => void; onOpenDetail: (exercise: Exercise, openerId?: string) => void }) {
  const [mediaReady, setMediaReady] = useState(false)
  const [mediaFailed, setMediaFailed] = useState(false)
  const clock = useWorkoutClock(guidedWorkoutPlanV2, {
    onVoiceEvent: (event) => speakWorkoutNumber(selectedVoice, event, onAudioStatusChange),
    onSilence: stopActiveCueAudio,
    onComplete,
  })
  const { snapshot } = clock
  const { runtime, segment } = snapshot
  const workoutExercise = guidedWorkoutPlanV2.exercises[segment.exerciseIndex ?? 0] ?? guidedWorkoutPlanV2.exercises[0]
  const exercise = exerciseCatalog.find((item) => item.id === workoutExercise.exerciseId) ?? todayPlan.exercises[0]
  const isActiveSegment = segment.kind === 'active'
  const isTransitionRest = segment.kind === 'transition_rest'
  const isResting = segment.kind === 'round_rest' || segment.kind === 'cooldown'
  const isPreparing = segment.kind === 'preparation'
  const paused = runtime.state === 'paused' || runtime.state === 'detail'
  const canOpenDetail = runtime.state === 'active' || runtime.state === 'paused' || runtime.state === 'detail'
  const exerciseNumber = (segment.exerciseIndex ?? 0) + 1
  const round = Math.min(guidedWorkoutPlanV2.rounds, segment.roundIndex + 1)

  useEffect(() => {
    if (detailOpen && runtime.state === 'active') clock.openDetail()
    if (!detailOpen && runtime.state === 'detail') clock.closeDetail()
  }, [clock.closeDetail, clock.openDetail, detailOpen, runtime.state])

  const handleMediaReady = () => {
    if (mediaReady) return
    setMediaReady(true)
    setMediaFailed(false)
    clock.start()
  }

  const handleOpenDetail = () => {
    if (!canOpenDetail) return
    if (runtime.state === 'active') clock.openDetail()
    onOpenDetail(exercise, 'workout-detail-trigger')
  }

  const handlePause = () => {
    if (runtime.state === 'paused') clock.resume()
    else clock.pause('manual')
  }

  const handleExit = () => {
    clock.exit()
    onExit()
  }

  const media = isResting
    ? <div className="rest-placeholder"><span>{segment.kind === 'cooldown' ? 'COOL DOWN' : 'REST'}</span><strong>{segment.kind === 'cooldown' ? '整理与恢复' : '休息一下'}</strong><small>{segment.kind === 'cooldown' ? '保持轻松呼吸，训练即将完成' : '下一轮即将开始'}</small></div>
    : <MotionPlayer workoutExercise={workoutExercise} exercise={exercise} elapsedMs={isActiveSegment || isPreparing || isTransitionRest ? snapshot.segmentElapsedMs : 0} paused={runtime.state === 'paused' || runtime.state === 'detail'} />

  let primaryValue = String(snapshot.remainingSeconds)
  let primaryLabel = isPreparing || isTransitionRest ? '开始倒计时' : isResting ? '休息倒计时' : '剩余秒数'
  if (isActiveSegment && workoutExercise.countingMode === 'repetition') {
    primaryValue = `${runtime.completedCount}/${workoutExercise.targetCount ?? 0}`
    primaryLabel = '跟练计数'
  }
  if (isActiveSegment && workoutExercise.countingMode === 'alternating_pair') {
    primaryValue = `${runtime.completedCount}/${workoutExercise.targetPerSide ?? 0} 组`
    primaryLabel = `左 ${runtime.leftCompleted}/${workoutExercise.targetPerSide ?? 0} · 右 ${runtime.rightCompleted}/${workoutExercise.targetPerSide ?? 0}`
  }
  if (isActiveSegment && workoutExercise.countingMode === 'timed') {
    primaryValue = String(snapshot.remainingSeconds)
    primaryLabel = '剩余秒数'
  }

  const captionTitle = isPreparing ? `第一个动作 · ${exercise.name}` : isTransitionRest ? `下一个动作 · ${exercise.name}` : segment.kind === 'cooldown' ? '整理与恢复' : isResting ? '下一轮准备' : exercise.name
  const captionCue = isPreparing ? '站好位置，3、2、1 后开始。' : isTransitionRest ? '下一个动作准备好，3、2、1 后开始。' : segment.kind === 'cooldown' ? '放松呼吸，让心率逐步恢复。' : exercise.cue
  const canSkip = (runtime.state === 'active' || runtime.state === 'rest') && segment.kind !== 'cooldown'
  const canPause = runtime.state === 'preparing' || runtime.state === 'active' || runtime.state === 'rest' || runtime.state === 'paused'

  return <div className="workout-overlay" role="dialog" aria-modal="true" aria-label="训练进行中">
    <WorkoutMediaPreloader exercises={guidedWorkoutPlanV2.exercises} onReady={handleMediaReady} onError={() => setMediaFailed(true)} />
    <div className="workout-sheet">
      <header className="workout-header">
        <button className="back-button" onClick={handleExit} aria-label="退出训练"><CaretLeft size={24} aria-hidden="true" /></button>
        <div className="workout-progress"><div className="progress-track"><span style={{ width: `${Math.max(snapshot.progress * 100, 1)}%` }} /></div><span>第 {round} / {guidedWorkoutPlanV2.rounds} 轮</span></div>
        <button className="text-button" onClick={handleExit}>退出</button>
      </header>
      <div className="workout-layout">
        <div className="workout-visual-pane">
          <div className="workout-stage">
            <div className="workout-stage__media">{media}</div>
          </div>
        </div>
        <div className="workout-control-pane">
          <button id="workout-detail-trigger" type="button" className="workout-stage__caption workout-stage__caption--button" onClick={handleOpenDetail} disabled={!canOpenDetail} aria-label={canOpenDetail ? '打开动作详情' : captionTitle}><span><span className={`target-pill target-pill--${exercise.targetTone}`}>{isResting ? '恢复呼吸' : exercise.target}</span><strong>{captionTitle}</strong><small>{mediaFailed && runtime.state === 'idle' ? '动作媒体加载失败，请检查网络后重新进入训练。' : captionCue}</small></span><span className="workout-timer"><strong>{String(snapshot.remainingSeconds).padStart(2, '0')}</strong><span>秒</span></span></button>
          <div className="workout-live-copy"><div><strong>{primaryValue}</strong><span>{primaryLabel}</span></div><div><strong>{paused ? '暂停' : runtime.state === 'idle' ? '加载' : isPreparing ? '准备' : isResting ? '休息' : '跟练'}</strong><span>当前状态</span></div><div><strong>{exerciseNumber}/{guidedWorkoutPlanV2.exercises.length}</strong><span>本轮动作</span></div></div>
          {audioStatus === 'blocked' && runtime.state !== 'idle' && segment.kind !== 'cooldown' && <button className="audio-enable-button" onClick={onEnableAudio}>声音未开启 · 点此重试</button>}
          <div className="workout-live-actions"><button className="secondary-button" onClick={clock.skip} disabled={!canSkip}>{isResting ? '跳过休息' : '跳过'}</button><button className="primary-button" onClick={handlePause} disabled={!canPause}>{runtime.state === 'paused' ? '继续训练' : '暂停训练'}</button></div>
        </div>
      </div>
    </div>
  </div>
}

function CalendarScreen({ sessions, onStart }: { sessions: CompletedSession[]; onStart: () => void }) {
  const today = new Date()
  const year = today.getFullYear()
  const month = today.getMonth()
  const monthLabel = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(today)
  const firstDay = new Date(year, month, 1).getDay() || 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const sessionKeys = new Set(sessions.map((session) => session.completedAt.slice(0, 10)))
  const cells = Array.from({ length: firstDay - 1 + daysInMonth }, (_, index) => index < firstDay - 1 ? null : index - firstDay + 2)
  const monthSessions = sessions.filter((session) => {
    const date = new Date(session.completedAt)
    return date.getFullYear() === year && date.getMonth() === month
  })

  return <div className="page page-calendar"><PageHeader eyebrow="把每一次完成留下来" title="训练日历" right={<div className="avatar" aria-hidden="true"><CalendarDots size={22} /></div>} /><section className="calendar-hero"><div><span className="soft-label">THIS MONTH</span><strong>{monthSessions.length}</strong><p>次训练完成</p></div><div className="calendar-hero__spark"><span /><span /><span /><span /><span /><span /><span /></div></section><section className="calendar-card"><div className="calendar-card__header"><strong>{monthLabel}</strong><span><i className="calendar-legend calendar-legend--done" />已完成</span></div><div className="calendar-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{cells.map((day, index) => { const dateKey = day ? `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` : ''; const done = Boolean(dateKey && sessionKeys.has(dateKey)); return <div key={`${dateKey}-${index}`} className={`calendar-day ${day === today.getDate() ? 'today' : ''} ${done ? 'done' : ''}`}>{day && <><span>{day}</span>{done && <i />}</>}</div> })}</div></section><section className="calendar-summary"><div><strong>{sessions.length}</strong><span>累计训练</span></div><div><strong>{sessions.reduce((sum, session) => sum + session.rounds, 0)}</strong><span>累计轮次</span></div><div><strong>{sessions.reduce((sum, session) => sum + session.estimatedCalories, 0)}</strong><span>估算千卡</span></div></section><section className="recent-section"><div className="section-heading section-heading--compact"><div><p className="eyebrow">RECENT ACTIVITY</p><h2>最近训练</h2></div></div>{sessions.length ? <div className="recent-list">{sessions.slice().reverse().slice(0, 5).map((session) => <div className="recent-row" key={session.completedAt}><span className="recent-row__date">{new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(session.completedAt))}</span><div><strong>{session.planTitle ?? '个人训练'}</strong><span>{session.rounds} 轮 · {session.exerciseCount ?? '—'} 个动作</span></div><b>完成</b></div>)}</div> : <div className="empty-calendar"><CalendarDots size={26} aria-hidden="true" /><strong>今天开始，日历会为你点亮</strong><p>完成一次训练后，这里会自动留下记录。</p></div>}</section><button className="primary-button sticky-action" onClick={onStart}><span>开始 15 分钟跟练</span><ArrowRight size={20} aria-hidden="true" /></button></div>
}

function ProfileScreen({ lastSession, storageReady, installState, onInstall, onExportBackup, onImportBackup }: { lastSession: CompletedSession | null; storageReady: boolean; installState: PwaInstallState; onInstall: () => void; onExportBackup: () => void; onImportBackup: (file: File) => void }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const installCard = installState === 'installed'
    ? <div className="install-card" role="status"><span className="install-icon" aria-hidden="true"><Check size={18} weight="bold" /></span><span><strong>已安装到桌面</strong><small>无需重复安装，可从桌面图标直接打开。</small></span></div>
    : installState === 'installable'
      ? <button className="install-card" onClick={onInstall}><span className="install-icon" aria-hidden="true"><DownloadSimple size={18} /></span><span><strong>安装到桌面</strong><small>使用浏览器安装提示，之后可像普通应用一样打开。</small></span><span className="chevron" aria-hidden="true"><CaretRight size={16} /></span></button>
      : <div className="install-card"><span className="install-icon" aria-hidden="true"><DeviceMobile size={18} /></span><span><strong>{installState === 'ios-guide' ? '添加到主屏幕' : '安装为桌面应用'}</strong><small>{installState === 'ios-guide' ? '在 Safari 点“分享”，再选择“添加到主屏幕”。' : '请在浏览器菜单中选择“安装应用”或“创建快捷方式”。'}</small></span></div>
  return <div className="page"><PageHeader eyebrow="把节奏留给自己" title="我的" right={<div className="avatar">M</div>} /><section className="profile-card profile-card--plain"><div><p className="eyebrow">当前教练</p><h2>{characterAssets.displayName}</h2><p>训练记录和偏好都保存在本机</p></div></section>{installCard}<section className="section-heading section-heading--compact"><div><p className="eyebrow">训练偏好</p><h2>当前设置</h2></div></section><div className="settings-list"><SettingRow icon={<Clock size={18} aria-hidden="true" />} title="单次训练时长" value={`约 ${lastSession?.planTitle ? activePlanLabel(lastSession.planTitle) : '15 分钟'}`} /><SettingRow icon={<Target size={18} aria-hidden="true" />} title="训练重点" value="臀腿力量" /><SettingRow icon={<CalendarDots size={18} aria-hidden="true" />} title="训练记录" value={lastSession ? formatDate(lastSession.completedAt) : '暂无记录'} /></div><section className="backup-card"><div><p className="eyebrow">LOCAL BACKUP</p><h2>资料备份</h2><p>把计划、训练日历和当前角色配置导出成一个 JSON 文件，可在另一台设备恢复。</p></div><div className="backup-actions"><button onClick={onExportBackup}>导出备份</button><button onClick={() => fileInput.current?.click()}>导入备份</button><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) onImportBackup(file); event.currentTarget.value = '' }} /></div></section><p className="muted-footnote">{storageReady ? '本机存储已就绪。训练时会自动跟随动作播放数字，详细动作要领请点开动作详情。' : '正在准备本机存储。'}</p></div>
}

function activePlanLabel(title: string) { return title.includes('快速') ? '8 分钟' : title.includes('个人') ? '自定义' : '15 分钟' }

function CompleteScreen({ session, totalExercises, onStart, onBackHome }: { session: CompletedSession | null; totalExercises: number; onStart: () => void; onBackHome: () => void }) {
  const safe = session ?? { completedAt: new Date().toISOString(), rounds: guidedWorkoutPlanV2.rounds, skipped: 0, estimatedCalories: 96 }
  return <div className="page page-complete"><div className="completion-mark"><span><Check size={24} weight="bold" aria-hidden="true" /></span></div><p className="eyebrow">训练完成</p><h1>今天的你，<br /><em>很棒。</em></h1><p className="complete-subtitle">{session?.planTitle ?? '臀腿基础力量'} · {safe.rounds} 轮</p><div className="result-grid"><div><strong>{safe.estimatedCalories}</strong><span>估算消耗 · 千卡</span></div><div><strong>{safe.rounds}</strong><span>完成轮次</span></div><div><strong>{Math.max(0, totalExercises - safe.skipped)}</strong><span>完成动作</span></div></div><div className="completion-message"><Sparkle size={18} aria-hidden="true" /><p>记得补充水分，给身体一点恢复时间。</p></div><button className="primary-button" onClick={onStart}><span>开始 15 分钟跟练</span><ArrowRight size={20} aria-hidden="true" /></button><button className="secondary-button secondary-button--wide" onClick={onBackHome}>回到首页</button></div>
}

function ExerciseRow({ exercise, index, onOpen }: { exercise: Exercise; index: number; onOpen: (exercise: Exercise, openerId?: string) => void }) {
  const contractExercise = guidedWorkoutPlanV2.exercises.find((item) => item.exerciseId === exercise.id)
  const countLabel = contractExercise?.countingMode === 'alternating_pair'
    ? `左右各 ${contractExercise.targetPerSide} 次`
    : `${contractExercise?.targetCount ?? exercise.reps} 次`
  const durationLabel = contractExercise ? `${contractExercise.segmentDurationMs / 1000} 秒` : exercise.duration
  const openerId = `exercise-preview-${exercise.id}`
  return <button id={openerId} className="exercise-row exercise-row--button" onClick={() => onOpen(exercise, openerId)}><div className={`exercise-index exercise-index--${exercise.targetTone}`}>{String(index + 1).padStart(2, '0')}</div><div className="exercise-row__body"><strong>{exercise.name}</strong><span>{exercise.equipment} · {exercise.target} · {countLabel}</span></div><span className="exercise-duration">{durationLabel}</span><CaretRight className="row-chevron" size={20} aria-hidden="true" /></button>
}

function SettingRow({ icon, title, value }: { icon: ReactNode; title: string; value: string }) { return <div className="setting-row"><span className="setting-icon" aria-hidden="true">{icon}</span><div><strong>{title}</strong><span>{value}</span></div><span className="chevron" aria-hidden="true"><CaretRight size={16} /></span></div> }

function BottomNav({ activeTab, onChange }: { activeTab: Tab; onChange: (tab: Tab) => void }) { return <nav className="bottom-nav" aria-label="主导航">{(Object.keys(tabLabels) as Tab[]).map((tab) => { const Icon = tabIconComponents[tab]; const active = activeTab === tab; return <button key={tab} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} onClick={() => onChange(tab)}><span className="nav-icon"><Icon size={22} weight={active ? 'fill' : 'regular'} aria-hidden="true" /></span><span>{tabLabels[tab]}</span></button> })}</nav> }

export default App
