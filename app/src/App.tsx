import { useEffect, useRef, useState, type ReactNode } from 'react'
import { characterAssets, voiceChoices } from './data/character'
import { motionById } from './data/motion'
import { exerciseCatalog, planPresets, todayPlan } from './data/plan'
import { STORAGE_KEYS, storage } from './lib/storage'
import type { CompletedSession, Exercise, MotionDefinition, Screen, Tab, TrainingPlan, VoiceChoice } from './types'

type Step = { round: number; exerciseIndex: number }
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const tabLabels: Record<Tab, string> = { home: '首页', plan: '计划', calendar: '日历', profile: '我的' }
const tabIcons: Record<Tab, string> = { home: '⌂', plan: '▦', calendar: '◷', profile: '◉' }
let activeCueAudio: HTMLAudioElement | null = null
const cueText = ''

// 训练页不再播放整句开场/动作解析口令。保留兼容签名，避免旧数据或旧组件引用时重新触发长语音。
function speakCue(_choice: VoiceChoice, _text = '', _useAsset = true, _fallbackUri?: string) {}

function speakRepCount(choice: VoiceChoice, count: number, uri?: string, variants: string[] = []) {
  const sources = [uri, ...variants].filter((value): value is string => Boolean(value))
    const selectedUri = sources.length ? sources[(count - 1) % sources.length] : undefined
  if (selectedUri) {
    const audio = new Audio(selectedUri)
    audio.playbackRate = choice.playbackRate ?? 1
    activeCueAudio?.pause()
    activeCueAudio = audio
    audio.onended = () => { if (activeCueAudio === audio) activeCueAudio = null }
    audio.onerror = () => { if (activeCueAudio === audio) activeCueAudio = null }
    void audio.play().catch(() => audio.onerror?.(new Event('error')))
  }
}

function hydrateStoredPlan(storedPlan: TrainingPlan): TrainingPlan {
  const latestExercises = new Map(exerciseCatalog.map((exercise) => [exercise.id, exercise]))
  return {
    ...storedPlan,
    exercises: storedPlan.exercises.map((exercise) => latestExercises.get(exercise.id) ?? exercise),
  }
}

function formatDate(dateString?: string) {
  if (!dateString) return '还没有训练记录'
  return `${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(dateString))} 已完成`
}

function App() {
  const shortcutView = new URLSearchParams(window.location.search).get('view')
  const initialTab: Tab = shortcutView === 'plan' ? 'plan' : shortcutView === 'calendar' ? 'calendar' : shortcutView === 'profile' ? 'profile' : 'home'
  const [activeTab, setActiveTab] = useState<Tab>(initialTab)
  const [screen, setScreen] = useState<Screen>(initialTab)
  const [activePlan, setActivePlan] = useState<TrainingPlan>(todayPlan)
  const [selectedIds, setSelectedIds] = useState<string[]>(todayPlan.exercises.map((exercise) => exercise.id))
  const [selectedRounds, setSelectedRounds] = useState(2)
  const [detailExercise, setDetailExercise] = useState<Exercise | null>(null)
  const [step, setStep] = useState<Step>({ round: 1, exerciseIndex: 0 })
  const [totalRounds, setTotalRounds] = useState(todayPlan.rounds)
  const [paused, setPaused] = useState(false)
  const [skipped, setSkipped] = useState(0)
  const [lastSession, setLastSession] = useState<CompletedSession | null>(null)
  const [sessions, setSessions] = useState<CompletedSession[]>([])
  const [savedPlans, setSavedPlans] = useState<TrainingPlan[]>([])
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const [selectedVoice, setSelectedVoice] = useState<VoiceChoice>(voiceChoices[0])
  const [storageReady, setStorageReady] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    Promise.all([
      storage.get<CompletedSession>(STORAGE_KEYS.lastSession),
      storage.get<CompletedSession[]>(STORAGE_KEYS.sessions),
      storage.get<TrainingPlan>('active-plan'),
      storage.get<TrainingPlan[]>(STORAGE_KEYS.plans),
      storage.get<string>('selected-voice'),
    ]).then(([session, storedSessions, storedPlan, storedPlans, storedVoice]) => {
      setLastSession(session)
      const history = storedSessions?.length ? storedSessions : session ? [session] : []
      setSessions(history)
      setSavedPlans((storedPlans ?? []).map(hydrateStoredPlan))
      if (!storedSessions?.length && session) void storage.set(STORAGE_KEYS.sessions, history)
      if (storedPlan) {
        const hydratedPlan = hydrateStoredPlan(storedPlan)
        setActivePlan(hydratedPlan)
        setSelectedIds(hydratedPlan.exercises.map((exercise) => exercise.id))
        setSelectedRounds(hydratedPlan.rounds)
        setEditingPlanId(hydratedPlan.source === 'personal' ? hydratedPlan.id : null)
        void storage.set('active-plan', hydratedPlan)
      }
      if (storedVoice) setSelectedVoice(voiceChoices.find((choice) => choice.id === storedVoice) ?? voiceChoices[0])
      setStorageReady(true)
    })

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
  }, [])

  useEffect(() => {
    if (notice) {
      const timer = window.setTimeout(() => setNotice(''), 3200)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [notice])

  const currentExercise = activePlan.exercises[step.exerciseIndex]
  const totalSteps = totalRounds * activePlan.exercises.length
  const completedSteps = (step.round - 1) * activePlan.exercises.length + step.exerciseIndex
  const progress = Math.min((completedSteps / totalSteps) * 100, 100)

  const chooseVoice = (choice: VoiceChoice) => {
    setSelectedVoice(choice)
    void storage.set('selected-voice', choice.id)
  }

  const startWorkout = (exercise?: Exercise) => {
    if (!activePlan.exercises.length) {
      setNotice('请先选择至少一个动作，再开始训练。')
      setActiveTab('plan')
      setScreen('plan')
      return
    }
    const index = exercise ? Math.max(activePlan.exercises.findIndex((item) => item.id === exercise.id), 0) : 0
    setStep({ round: 1, exerciseIndex: index })
    setTotalRounds(activePlan.rounds)
    setSkipped(0)
    setPaused(false)
    setScreen('workout')
  }

  const advance = (wasSkipped = false) => {
    const nextSkipped = skipped + (wasSkipped ? 1 : 0)
    if (step.exerciseIndex === activePlan.exercises.length - 1 && step.round === totalRounds) {
      const session: CompletedSession = {
        completedAt: new Date().toISOString(),
        rounds: totalRounds,
        skipped: nextSkipped,
        estimatedCalories: activePlan.estimatedCalories + Math.max(totalRounds - activePlan.rounds, 0) * 18,
        planTitle: activePlan.title,
        exerciseCount: activePlan.exercises.length,
      }
      setLastSession(session)
      setSessions((history) => {
        const next = [...history, session].slice(-60)
        void storage.set(STORAGE_KEYS.sessions, next)
        return next
      })
      setPaused(false)
      setScreen('complete')
      void storage.set(STORAGE_KEYS.lastSession, session)
      return
    }
    if (wasSkipped) setSkipped(nextSkipped)
    const lastExercise = step.exerciseIndex === activePlan.exercises.length - 1
    setStep({ round: lastExercise ? step.round + 1 : step.round, exerciseIndex: lastExercise ? 0 : step.exerciseIndex + 1 })
    setPaused(false)
  }

  const addExtraRound = () => {
    const extraRound = totalRounds + 1
    setTotalRounds(extraRound)
    setStep({ round: extraRound, exerciseIndex: 0 })
    setPaused(false)
    setScreen('workout')
  }

  const goToTab = (tab: Tab) => {
    setActiveTab(tab)
    setScreen(tab)
  }

  const openDetail = (exercise: Exercise) => {
    setDetailExercise(exercise)
    setScreen('detail')
  }

  const generatePersonalPlan = () => {
    const exercises = exerciseCatalog.filter((exercise) => selectedIds.includes(exercise.id))
    if (!exercises.length) {
      setNotice('至少选择一个动作，再生成个人计划')
      return
    }
    const existingPlan = editingPlanId ? savedPlans.find((item) => item.id === editingPlanId) : null
    const plan: TrainingPlan = {
      id: editingPlanId ?? `personal-${Date.now()}`,
      title: '我的个人计划',
      subtitle: `自选 ${exercises.length} 个动作 · ${selectedRounds} 轮`,
      duration: Math.max(5, Math.round(exercises.length * selectedRounds * 1.9)),
      rounds: selectedRounds,
      estimatedCalories: Math.round(exercises.length * selectedRounds * 12),
      source: 'personal',
      exercises,
    }
    if (existingPlan) plan.title = existingPlan.title
    setActivePlan(plan)
    setSavedPlans((plans) => {
      const next = [...plans.filter((item) => item.id !== plan.id), plan]
      void storage.set(STORAGE_KEYS.plans, next)
      return next
    })
    void storage.set('active-plan', plan)
    setActiveTab('home')
    setScreen('home')
    setNotice('个人计划已生成，首页可以直接开始')
  }

  const applyPlan = (plan: TrainingPlan) => {
    const hydratedPlan = hydrateStoredPlan(plan)
    setActivePlan(hydratedPlan)
    setSelectedIds(hydratedPlan.exercises.map((exercise) => exercise.id))
    setSelectedRounds(hydratedPlan.rounds)
    setEditingPlanId(hydratedPlan.source === 'personal' && hydratedPlan.id !== 'personal-draft' ? hydratedPlan.id : null)
    void storage.set('active-plan', hydratedPlan)
    setNotice(`已切换到「${plan.title}」`)
  }

  const addPlanToLibrary = (plan: TrainingPlan, announce = true) => {
    const hydratedPlan = hydrateStoredPlan(plan)
    const libraryPlan: TrainingPlan = {
      ...hydratedPlan,
      id: `library-${plan.id}-${Date.now()}`,
      source: 'personal',
    }
    setSavedPlans((plans) => {
      const next = [...plans, libraryPlan]
      void storage.set(STORAGE_KEYS.plans, next)
      return next
    })
    setActivePlan(libraryPlan)
    setSelectedIds(libraryPlan.exercises.map((exercise) => exercise.id))
    setSelectedRounds(libraryPlan.rounds)
    setEditingPlanId(libraryPlan.id)
    void storage.set('active-plan', libraryPlan)
    if (announce) setNotice(`已添加「${plan.title}」到我的计划库，可继续修改或删除`)
    return libraryPlan
  }

  const addPresetToLibrary = (plan: TrainingPlan) => {
    addPlanToLibrary(plan)
  }

  const editCurrentPlan = () => {
    if (activePlan.source === 'preset') {
      addPlanToLibrary(activePlan, false)
      setNotice('已复制到我的计划库，现在可以修改动作、轮次或名称')
      setActiveTab('plan')
      setScreen('plan')
      return
    }
    setSelectedIds(activePlan.exercises.map((exercise) => exercise.id))
    setSelectedRounds(activePlan.rounds)
    setEditingPlanId(activePlan.source === 'personal' && activePlan.id !== 'personal-draft' ? activePlan.id : null)
    setActiveTab('plan')
    setScreen('plan')
  }

  const createNewPlan = () => {
    setActivePlan({ id: 'personal-draft', title: '新建个人计划', subtitle: '按肌群选择动作，保存后即可套用。', duration: 0, rounds: 2, estimatedCalories: 0, source: 'personal', exercises: [] })
    setSelectedIds([])
    setSelectedRounds(2)
    setEditingPlanId(null)
    setActiveTab('plan')
    setScreen('plan')
    setNotice('已打开新计划，按肌群选择动作后保存。')
  }

  const renamePlan = (planId: string) => {
    const plan = savedPlans.find((item) => item.id === planId)
    if (!plan) return
    const nextTitle = window.prompt('给这个计划改个名字', plan.title)?.trim()
    if (!nextTitle || nextTitle === plan.title) return
    const nextPlans = savedPlans.map((item) => item.id === planId ? { ...item, title: nextTitle, subtitle: item.subtitle.replace(plan.title, nextTitle) } : item)
    setSavedPlans(nextPlans)
    void storage.set(STORAGE_KEYS.plans, nextPlans)
    if (activePlan.id === planId) {
      const nextActive = { ...activePlan, title: nextTitle, subtitle: activePlan.subtitle.replace(plan.title, nextTitle) }
      setActivePlan(nextActive)
      void storage.set('active-plan', nextActive)
    }
    setNotice(`计划已改名为「${nextTitle}」`)
  }

  const deletePlan = (planId: string) => {
    const plan = savedPlans.find((item) => item.id === planId)
    if (!plan) return
    if (!window.confirm(`删除「${plan.title}」？训练记录不会受到影响。`)) return
    const nextPlans = savedPlans.filter((item) => item.id !== planId)
    setSavedPlans(nextPlans)
    void storage.set(STORAGE_KEYS.plans, nextPlans)
    if (activePlan.id === planId) {
      const fallback = hydrateStoredPlan(todayPlan)
      setActivePlan(fallback)
      setSelectedIds(fallback.exercises.map((exercise) => exercise.id))
      setSelectedRounds(fallback.rounds)
      setEditingPlanId(null)
      void storage.set('active-plan', fallback)
    }
    setNotice('计划已删除，已切回默认训练计划')
  }

  const exportBackup = async () => {
    const backup = {
      format: 'wriothesley-training-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      activePlan,
      savedPlans,
      sessions,
      lastSession,
      selectedVoiceId: selectedVoice.id,
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `训练教练备份-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setNotice('备份文件已导出，请保存到安全位置')
  }

  const importBackup = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as {
        format?: string
        activePlan?: TrainingPlan
        savedPlans?: TrainingPlan[]
        sessions?: CompletedSession[]
        lastSession?: CompletedSession | null
        selectedVoiceId?: string
      }
      if (parsed.format !== 'wriothesley-training-backup' || !parsed.activePlan || !Array.isArray(parsed.savedPlans) || !Array.isArray(parsed.sessions)) {
        throw new Error('invalid backup')
      }
      const nextActive = hydrateStoredPlan(parsed.activePlan)
      const nextPlans = parsed.savedPlans.map(hydrateStoredPlan)
      setActivePlan(nextActive)
      setSelectedIds(nextActive.exercises.map((exercise) => exercise.id))
      setSelectedRounds(nextActive.rounds)
      setSavedPlans(nextPlans)
      setSessions(parsed.sessions)
      setLastSession(parsed.lastSession ?? null)
      if (parsed.selectedVoiceId) setSelectedVoice(voiceChoices.find((choice) => choice.id === parsed.selectedVoiceId) ?? voiceChoices[0])
      await Promise.all([
        storage.set('active-plan', nextActive),
        storage.set(STORAGE_KEYS.plans, nextPlans),
        storage.set(STORAGE_KEYS.sessions, parsed.sessions),
        storage.set(STORAGE_KEYS.lastSession, parsed.lastSession ?? null),
      ])
      setNotice('备份已恢复，计划和训练记录都已载入')
    } catch {
      setNotice('备份文件无法读取，请选择训练教练导出的 JSON 文件')
    }
  }

  const installApp = async () => {
    if (!installPrompt) {
      setNotice('请在浏览器菜单中选择“安装应用”或“添加到桌面”')
      return
    }
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  return (
    <div className="app-shell">
      <main className="app-main">
        {screen === 'workout' && currentExercise ? (
          <WorkoutScreenModal
            exercise={currentExercise}
            round={step.round}
            totalRounds={totalRounds}
            exerciseNumber={step.exerciseIndex + 1}
            totalExercises={activePlan.exercises.length}
            progress={progress}
            paused={paused}
            selectedVoice={selectedVoice}
            onPause={() => setPaused((value) => !value)}
            onSkip={() => advance(true)}
            onComplete={() => advance(false)}
            onExit={() => goToTab('home')}
            onOpenDetail={openDetail}
          />
        ) : screen === 'complete' ? (
          <CompleteScreen session={lastSession} totalExercises={activePlan.exercises.length} onAddRound={addExtraRound} onBackHome={() => goToTab('home')} />
        ) : screen === 'detail' && detailExercise ? (
          <DetailScreen exercise={detailExercise} onBack={() => goToTab('plan')} onStart={() => startWorkout(detailExercise)} />
        ) : screen === 'plan' ? (
          <PlanScreen activePlan={activePlan} savedPlans={savedPlans} editingPlanId={editingPlanId} selectedIds={selectedIds} selectedRounds={selectedRounds} onToggle={(id) => setSelectedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id])} onRoundsChange={setSelectedRounds} onGenerate={generatePersonalPlan} onAddPreset={addPresetToLibrary} onApplyPlan={applyPlan} onEditCurrent={editCurrentPlan} onCreateNew={createNewPlan} onRenamePlan={renamePlan} onDeletePlan={deletePlan} onOpenDetail={openDetail} onStart={() => startWorkout()} />
        ) : screen === 'calendar' ? (
          <CalendarScreen sessions={sessions} onStart={() => startWorkout()} />
        ) : screen === 'profile' ? (
          <ProfileScreen lastSession={lastSession} storageReady={storageReady} installAvailable={Boolean(installPrompt)} onInstall={installApp} onExportBackup={exportBackup} onImportBackup={importBackup} />
        ) : (
          <HomeScreen activePlan={activePlan} lastSession={lastSession} onStart={() => startWorkout()} onOpenPlan={() => goToTab('plan')} onOpenDetail={openDetail} />
        )}
      </main>
      {screen !== 'workout' && screen !== 'detail' && <BottomNav activeTab={activeTab} onChange={goToTab} />}
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  )
}

function PageHeader({ eyebrow, title, right }: { eyebrow?: string; title: string; right?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1></div>{right}</header>
}

function HomeScreen({ activePlan, lastSession, onStart, onOpenPlan, onOpenDetail }: { activePlan: TrainingPlan; lastSession: CompletedSession | null; onStart: () => void; onOpenPlan: () => void; onOpenDetail: (exercise: Exercise) => void }) {
  return <div className="page page-home">
    <PageHeader eyebrow="今天也留一点时间给自己" title="跟着教练，稳稳练起来" right={<div className="avatar">LC</div>} />
    <section className="hero-card hero-card--media">
      <img src={characterAssets.actionPosterUri} alt="莱欧斯利训练教练在健身房示范高脚杯深蹲" />
      <div className="hero-card__overlay" />
      <div className="hero-card__copy"><span className="soft-label">TODAY'S FOCUS</span><h2>{activePlan.title}</h2><p>{activePlan.subtitle}</p><div className="hero-meta"><span>◷ 约 {activePlan.duration} 分钟</span><span>● {activePlan.exercises.length} 个动作</span></div></div>
      <span className="lock-chip">角色一致性：已锁定</span>
    </section>
    <section className="section-heading"><div><p className="eyebrow">当前计划</p><h2>{activePlan.title}</h2></div><button className="text-link" onClick={onOpenPlan}>调整计划</button></section>
    <div className="exercise-preview-list">{activePlan.exercises.map((exercise, index) => <ExerciseRow key={exercise.id} exercise={exercise} index={index} onOpen={onOpenDetail} />)}</div>
    <button className="primary-button sticky-action" onClick={onStart}><span>{lastSession ? '再次开始训练' : '开始训练'}</span><span aria-hidden="true">→</span></button>
    <p className="last-session-note">{lastSession ? `上次训练：${formatDate(lastSession.completedAt)}` : '完成训练后，记录只保存在本机'}</p>
    <section className="character-mini-card"><img src={characterAssets.lockSheetUri} alt="角色多视图锁定表" /><div><p className="eyebrow">CHARACTER LOCK</p><strong>{characterAssets.displayName}</strong><span>同一张角色资产贯穿图片、GIF与后续视频，不是形象选择器。</span><span>{characterAssets.earOrnament}</span><span>{characterAssets.neck}</span></div></section>
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

function PlanScreen({ activePlan, savedPlans, editingPlanId, selectedIds, selectedRounds, onToggle, onRoundsChange, onGenerate, onAddPreset, onApplyPlan, onEditCurrent, onCreateNew, onRenamePlan, onDeletePlan, onOpenDetail, onStart }: { activePlan: TrainingPlan; savedPlans: TrainingPlan[]; editingPlanId: string | null; selectedIds: string[]; selectedRounds: number; onToggle: (id: string) => void; onRoundsChange: (rounds: number) => void; onGenerate: () => void; onAddPreset: (plan: TrainingPlan) => void; onApplyPlan: (plan: TrainingPlan) => void; onEditCurrent: () => void; onCreateNew: () => void; onRenamePlan: (planId: string) => void; onDeletePlan: (planId: string) => void; onOpenDetail: (exercise: Exercise) => void; onStart: () => void }) {
  const [muscleFilter, setMuscleFilter] = useState<'全部' | string>('全部')
  const [equipmentFilter, setEquipmentFilter] = useState<'全部' | Exercise['equipment']>('全部')
  const visibleExercises = exerciseCatalog.filter((exercise) => {
    const matchesMuscle = muscleFilter === '全部' || getMuscleGroups(exercise).includes(muscleFilter)
    const matchesEquipment = equipmentFilter === '全部' || exercise.equipment === equipmentFilter
    return matchesMuscle && matchesEquipment
  })
  const groupedExercises = (muscleFilter === '全部' ? muscleGroupOrder : [muscleFilter])
    .map((group) => ({ group, exercises: visibleExercises.filter((exercise) => getMuscleGroups(exercise).includes(group)) }))
    .filter((section) => section.exercises.length)
  return <div className="page page-plan">
    <PageHeader eyebrow="先选目标，再开始训练" title="训练计划" />
    <section className="plan-summary"><div className="plan-summary__top"><span className="soft-label">CURRENT PLAN</span><span className="status-dot">{activePlan.source === 'personal' ? '个人计划' : '已准备'}</span></div><h2>{activePlan.title}</h2><p>{activePlan.subtitle}</p><div className="plan-stats"><div><strong>{activePlan.exercises.length}</strong><span>个动作</span></div><div><strong>{activePlan.duration}<span>min</span></strong><span>预计时长</span></div><div><strong>{activePlan.rounds}</strong><span>默认轮次</span></div></div></section>
    <div className="plan-edit-actions"><button className="secondary-button" onClick={onEditCurrent}>修改当前计划</button><button className="secondary-button" onClick={onCreateNew}>新建个人计划</button></div>
    {activePlan.source === 'personal' && activePlan.id !== 'personal-draft' && <div className="active-plan-tools"><span>当前是已保存的个人计划</span><div><button onClick={() => onRenamePlan(activePlan.id)}>改名</button><button className="danger-link" onClick={() => onDeletePlan(activePlan.id)}>删除</button></div></div>}
    {savedPlans.length > 0 && <><section className="section-heading section-heading--compact"><div><p className="eyebrow">我的计划库</p><h2>已保存的训练</h2></div></section><div className="saved-plan-list">{savedPlans.map((plan) => <div className={`saved-plan-row ${activePlan.id === plan.id ? 'selected' : ''}`} key={plan.id}><div><strong>{plan.title}</strong><span>{plan.exercises.length} 个动作 · {plan.rounds} 轮</span></div><div className="saved-plan-row__actions"><button onClick={() => onApplyPlan(plan)}>套用</button><button className="ghost-action" onClick={() => onRenamePlan(plan.id)} aria-label={`重命名${plan.title}`}>改名</button><button className="ghost-action danger-link" onClick={() => onDeletePlan(plan.id)} aria-label={`删除${plan.title}`}>删除</button></div></div>)}</div></>}
    <section className="section-heading section-heading--compact"><div><p className="eyebrow">更多健身计划</p><h2>添加后可修改或删除</h2></div></section>
    <div className="preset-grid">{planPresets.map((plan) => <button key={plan.id} className="preset-card" onClick={() => onAddPreset(plan)}><strong>{plan.title}</strong><span>{plan.duration} 分钟 · {plan.exercises.length} 个动作</span><em>添加到我的计划</em></button>)}</div>
    <section className="section-heading section-heading--compact"><div><p className="eyebrow">个人计划 · 两层筛选</p><h2>选择对应动作</h2></div><span className="round-badge">{selectedIds.length} 个已选</span></section>
    <div className="filter-stack"><div className="filter-row"><span>选择肌群</span><div className="muscle-filter">{(['全部', ...muscleGroupOrder] as const).map((group) => <button key={group} className={muscleFilter === group ? 'selected' : ''} onClick={() => setMuscleFilter(group)}>{group}</button>)}</div></div><div className="filter-row"><span>选择器械</span><div className="equipment-filter">{(['全部', '徒手', '椅子辅助', '哑铃'] as const).map((equipment) => <button key={equipment} className={equipmentFilter === equipment ? 'selected' : ''} onClick={() => setEquipmentFilter(equipment)}>{equipment}</button>)}</div></div></div>
    <div className="exercise-groups">{groupedExercises.map(({ group, exercises }) => <section className="muscle-group" key={group}><div className="muscle-group__heading"><strong>{group}</strong><span>{exercises.length} 个动作</span></div><div className="exercise-select-list">{exercises.map((exercise) => <button key={exercise.id} className={`exercise-select ${selectedIds.includes(exercise.id) ? 'selected' : ''}`} onClick={() => onToggle(exercise.id)}><span className="exercise-check">{selectedIds.includes(exercise.id) ? '✓' : ''}</span><span><strong>{exercise.name}</strong><small>{exercise.equipment} · {exercise.target} · {exercise.duration}</small></span><span className="info-mark" onClick={(event) => { event.stopPropagation(); onOpenDetail(exercise) }}>i</span></button>)}</div></section>)}</div>
    <div className="round-picker"><span>轮次</span><div>{[1, 2, 3].map((round) => <button key={round} className={selectedRounds === round ? 'selected' : ''} onClick={() => onRoundsChange(round)}>{round} 轮</button>)}</div></div>
    <button className="primary-button sticky-action" onClick={onGenerate} disabled={!selectedIds.length}><span>{editingPlanId ? '保存修改并套用' : '保存并套用到当前计划'}</span><span aria-hidden="true">→</span></button>
    <button className="secondary-button secondary-button--wide" onClick={onStart} disabled={!activePlan.exercises.length}>按当前计划开始</button>
  </div>
}

function ActionPoster({ exercise }: { exercise: Exercise }) {
  return <div className="action-poster" role="img" aria-label={`${exercise.name}动作海报`}>
    <div className="action-poster__figure" aria-hidden="true"><span className="action-poster__head" /><span className="action-poster__torso" /><span className="action-poster__leg action-poster__leg--left" /><span className="action-poster__leg action-poster__leg--right" /></div>
    <div className="action-poster__copy"><span>{exercise.equipment} · {exercise.target}</span><strong>{exercise.name}</strong><small>标准动作海报</small></div>
  </div>
}

function MotionPlayer({ motion, paused, maxReps, onRepCompleted }: { motion: MotionDefinition; paused: boolean; maxReps: number; onRepCompleted: (rep: number) => void }) {
  const [elapsed, setElapsed] = useState(0)
  const announcedRep = useRef(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const duration = motion.loopDuration
  const checkpoints = motion.cues.filter((cue) => cue.type === 'rep_checkpoint').map((cue) => cue.time).sort((a, b) => a - b)
  const frameUris = motion.frameUris ?? []
  const frameDurations = frameUris.length
    ? (motion.frameDurations?.length === frameUris.length ? motion.frameDurations : frameUris.map(() => duration / frameUris.length))
    : []
  const frameTotal = frameDurations.reduce((sum, value) => sum + value, 0)
  const frameClock = frameTotal ? ((elapsed % duration) / duration) * frameTotal : 0
  let frameIndex = 0
  let frameCursor = 0
  while (frameIndex < frameDurations.length - 1 && frameClock >= frameCursor + frameDurations[frameIndex]) {
    frameCursor += frameDurations[frameIndex]
    frameIndex += 1
  }
  const cycleNumber = Math.floor(elapsed / duration)
  const cycleProgress = (elapsed % duration) / duration
  const completedRep = Math.min(maxReps, cycleNumber * checkpoints.length + checkpoints.filter((time) => cycleProgress >= time).length)
  const phase = motion.phases.find((item) => (elapsed % duration) / duration >= item.start && (elapsed % duration) / duration < item.end)?.id ?? motion.phases[0]?.id ?? 'cycle'

  useEffect(() => {
    setElapsed(0)
    announcedRep.current = 0
  }, [motion.id])

  useEffect(() => {
    for (const uri of [motion.poster, motion.loop, ...frameUris]) {
      const image = new Image()
      image.src = uri
    }
  }, [frameUris, motion.loop, motion.poster])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (paused) video.pause()
    else void video.play().catch(() => undefined)
  }, [paused, motion.id])

  useEffect(() => {
    if (paused) return undefined
    const timer = window.setInterval(() => setElapsed((value) => Math.min(maxReps * duration, value + 0.05)), 50)
    return () => window.clearInterval(timer)
  }, [duration, maxReps, motion.id, paused])

  useEffect(() => {
    if (completedRep > announcedRep.current) {
      announcedRep.current = completedRep
      onRepCompleted(completedRep)
    }
  }, [completedRep, onRepCompleted])

  const videoUri = motion.webm ?? (motion.assetType === 'video' ? motion.loop : undefined)
  const hasFormalVideo = Boolean(videoUri || motion.mp4)
  return <div className="motion-player">
    {hasFormalVideo ? <video ref={videoRef} poster={motion.poster} autoPlay={!paused} loop muted playsInline><source src={videoUri} type="video/webm" />{motion.mp4 && <source src={motion.mp4} type="video/mp4" />}</video> : frameUris.length ? <img src={paused ? motion.poster : frameUris[frameIndex]} alt={motion.accessibility.altText} /> : <img src={paused ? motion.poster : motion.loop} alt={motion.accessibility.altText} />}
    <div className="motion-player__meta"><span>{paused ? '画面已暂停' : `动作阶段 · ${phase}`}</span><span>{hasFormalVideo ? '30 FPS WebM / MP4' : frameUris.length ? '固定机位逐帧演示' : '预渲染循环'}</span></div>
  </div>
}

function DetailScreen({ exercise, onBack, onStart }: { exercise: Exercise; onBack: () => void; onStart: () => void }) {
  return <div className="page page-detail"><button className="back-link" onClick={onBack}>‹ 返回计划</button><div className="detail-media">{exercise.media.videoUri ? <video src={exercise.media.videoUri} poster={exercise.media.posterUri} controls loop playsInline /> : exercise.media.posterUri ? <img src={exercise.media.posterUri} alt={`${exercise.name}动作海报`} /> : <ActionPoster exercise={exercise} />}<span className="detail-badge">动作解析</span></div><div className={`target-pill target-pill--${exercise.targetTone}`}>{exercise.target}</div><h1>{exercise.name}</h1><p className="cue-line">{exercise.cue}</p><section className="detail-section"><h2>动作步骤</h2><ol>{exercise.steps.map((step) => <li key={step}>{step}</li>)}</ol></section><section className="detail-section detail-section--soft"><h2>呼吸与提醒</h2><p><strong>呼吸：</strong>{exercise.breathing}</p><ul>{exercise.reminders.map((reminder) => <li key={reminder}>{reminder}</li>)}</ul></section><p className="detail-audio-note">训练时只播放低沉版计数口令；标准动作和详细提醒都在本页查看，避免训练中反复播报。</p><button className="primary-button sticky-action" onClick={onStart}>用这个动作开始</button></div>
}

function WorkoutScreenModal({ exercise, round, totalRounds, exerciseNumber, totalExercises, progress, paused, selectedVoice, onPause, onSkip, onComplete, onExit, onOpenDetail }: { exercise: Exercise; round: number; totalRounds: number; exerciseNumber: number; totalExercises: number; progress: number; paused: boolean; selectedVoice: VoiceChoice; onPause: () => void; onSkip: () => void; onComplete: () => void; onExit: () => void; onOpenDetail: (exercise: Exercise) => void }) {
  const totalSeconds = Number.parseInt(exercise.duration, 10) || 45
  const [secondsLeft, setSecondsLeft] = useState(totalSeconds)
  const [restSeconds, setRestSeconds] = useState<number | null>(null)
  const lastAnnouncedRep = useRef(0)
  const [motionRep, setMotionRep] = useState(0)
  const actionCue = `提醒。${exercise.tips[0] ?? exercise.cue}`
  const actionStartUri = exercise.media.coachingAudio?.startUri
  const isResting = restSeconds !== null
  const motion = exercise.media.motionId ? motionById[exercise.media.motionId] : undefined
  const timerRep = Math.min(exercise.reps, Math.floor(((totalSeconds - secondsLeft) / totalSeconds) * exercise.reps))
  const currentRep = isResting ? exercise.reps : motion ? motionRep : timerRep

  useEffect(() => {
    setSecondsLeft(totalSeconds)
    setRestSeconds(null)
    lastAnnouncedRep.current = 0
    setMotionRep(0)
  }, [exercise.id, round, totalSeconds])

  useEffect(() => {
    if (paused || isResting) return undefined
    const timer = window.setInterval(() => setSecondsLeft((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [paused, isResting, exercise.id, round])

  useEffect(() => {
    if (!paused && !isResting && currentRep > lastAnnouncedRep.current) {
      lastAnnouncedRep.current = currentRep
      speakRepCount(selectedVoice, currentRep, exercise.media.coachingAudio?.countUris?.[currentRep - 1], exercise.media.coachingAudio?.countVariants?.[currentRep - 1])
    }
  }, [currentRep, isResting, paused, selectedVoice, exercise.media.coachingAudio])

  useEffect(() => {
    if (paused || isResting || secondsLeft !== 0) return undefined
    if (exerciseNumber === totalExercises && round === totalRounds) {
      const timer = window.setTimeout(onComplete, 650)
      return () => window.clearTimeout(timer)
    }
    setRestSeconds(10)
    return undefined
  }, [paused, isResting, secondsLeft, exerciseNumber, totalExercises, round, totalRounds, onComplete])

  useEffect(() => {
    if (paused || restSeconds === null) return undefined
    if (restSeconds === 0) {
      const timer = window.setTimeout(onComplete, 500)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setInterval(() => setRestSeconds((value) => value === null ? null : Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [paused, restSeconds, onComplete])

  useEffect(() => {
    if (isResting || !actionStartUri) return undefined
    speakCue({ ...selectedVoice, audioUri: actionStartUri }, actionCue)
    return () => {
      activeCueAudio?.pause()
    }
  }, [exercise.id, round, selectedVoice.id, actionCue, actionStartUri, isResting])

  const media = isResting
    ? <div className="rest-placeholder"><span>REST</span><strong>休息一下</strong><small>下一动作即将开始</small></div>
    : motion
      ? <MotionPlayer key={motion.id} motion={motion} paused={paused || secondsLeft === 0} maxReps={exercise.reps} onRepCompleted={setMotionRep} />
    : exercise.media.videoUri
        ? <video src={exercise.media.videoUri} poster={exercise.media.posterUri} autoPlay loop muted playsInline />
        : exercise.media.posterUri
          ? <img src={exercise.media.posterUri} alt={`${exercise.name}示范`} />
          : <ActionPoster exercise={exercise} />

  return <div className="workout-overlay" role="dialog" aria-modal="true" aria-label="训练进行中"><div className="workout-sheet"><header className="workout-header"><button className="back-button" onClick={onExit} aria-label="退出训练">‹</button><div className="workout-progress"><div className="progress-track"><span style={{ width: `${Math.max(progress, 4)}%` }} /></div><span>第 {round} / {totalRounds} 轮</span></div><button className="text-button" onClick={onExit}>退出</button></header><div className="workout-stage"><div className="workout-stage__media">{media}</div><div className="workout-stage__topline"><span>{isResting ? '动作间休息' : `动作 ${exerciseNumber} / ${totalExercises}`}</span><span>{isResting ? `${restSeconds} 秒后继续` : motion ? '动作媒体预览' : '动作示范'}</span></div><button type="button" className="workout-stage__caption workout-stage__caption--button" onClick={() => { if (!isResting) onOpenDetail(exercise) }} disabled={isResting} aria-label={isResting ? '休息中' : '打开动作详情'}><span><span className={`target-pill target-pill--${isResting ? 'gold' : exercise.targetTone}`}>{isResting ? '恢复呼吸' : exercise.target}</span><strong>{isResting ? '准备下一个动作' : exercise.name}</strong><small>{isResting ? '放松呼吸，保持站位，下一动作会自动开始。' : exercise.cue}</small></span><span className="workout-timer"><strong>{String(isResting ? restSeconds : secondsLeft).padStart(2, '0')}</strong><span>秒</span></span></button><div className="workout-stage__status"><span className="live-dot" />{isResting ? '休息结束后自动继续' : '计数随动作节点同步 · 点卡片看详情'}</div></div><div className="workout-live-copy"><div><strong>{currentRep}/{exercise.reps}</strong><span>自动计数</span></div><div><strong>{isResting ? '休息' : secondsLeft === 0 ? '完成' : '保持'}</strong><span>{isResting ? '无需操作' : '动作节奏'}</span></div><div><strong>{exerciseNumber}/{totalExercises}</strong><span>本轮动作</span></div></div><div className="workout-live-actions"><button className="secondary-button" onClick={onSkip}>{isResting ? '跳过休息' : '跳过'}</button></div>{paused && <div className="pause-banner"><span>训练时画面、计时与计次已停</span><button className="small-button" onClick={onPause}>继续</button></div>}<button className="pause-button" onClick={onPause}>{paused ? '继续训练' : '暂停训练'}</button></div></div>
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

  return <div className="page page-calendar"><PageHeader eyebrow="把每一次完成留下来" title="训练日历" right={<div className="avatar">◷</div>} /><section className="calendar-hero"><div><span className="soft-label">THIS MONTH</span><strong>{monthSessions.length}</strong><p>次训练完成</p></div><div className="calendar-hero__spark"><span /><span /><span /><span /><span /><span /><span /></div></section><section className="calendar-card"><div className="calendar-card__header"><strong>{monthLabel}</strong><span><i className="calendar-legend calendar-legend--done" />已完成</span></div><div className="calendar-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{cells.map((day, index) => { const dateKey = day ? `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` : ''; const done = Boolean(dateKey && sessionKeys.has(dateKey)); return <div key={`${dateKey}-${index}`} className={`calendar-day ${day === today.getDate() ? 'today' : ''} ${done ? 'done' : ''}`}>{day && <><span>{day}</span>{done && <i />}</>}</div> })}</div></section><section className="calendar-summary"><div><strong>{sessions.length}</strong><span>累计训练</span></div><div><strong>{sessions.reduce((sum, session) => sum + session.rounds, 0)}</strong><span>累计轮次</span></div><div><strong>{sessions.reduce((sum, session) => sum + session.estimatedCalories, 0)}</strong><span>估算千卡</span></div></section><section className="recent-section"><div className="section-heading section-heading--compact"><div><p className="eyebrow">RECENT ACTIVITY</p><h2>最近训练</h2></div></div>{sessions.length ? <div className="recent-list">{sessions.slice().reverse().slice(0, 5).map((session) => <div className="recent-row" key={session.completedAt}><span className="recent-row__date">{new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(session.completedAt))}</span><div><strong>{session.planTitle ?? '个人训练'}</strong><span>{session.rounds} 轮 · {session.exerciseCount ?? '—'} 个动作</span></div><b>完成</b></div>)}</div> : <div className="empty-calendar"><span>◷</span><strong>今天开始，日历会为你点亮</strong><p>完成一次训练后，这里会自动留下记录。</p></div>}</section><button className="primary-button sticky-action" onClick={onStart}>开始今天的训练 <span aria-hidden="true">→</span></button></div>
}

function ProfileScreen({ lastSession, storageReady, installAvailable, onInstall, onExportBackup, onImportBackup }: { lastSession: CompletedSession | null; storageReady: boolean; installAvailable: boolean; onInstall: () => void; onExportBackup: () => void; onImportBackup: (file: File) => void }) {
  const fileInput = useRef<HTMLInputElement>(null)
  return <div className="page"><PageHeader eyebrow="把节奏留给自己" title="我的" right={<div className="avatar">M</div>} /><section className="profile-card"><div className="profile-avatar">LC</div><div><h2>{characterAssets.displayName}</h2><p>角色资产与训练记录都保存在本机</p></div><span className="chevron">›</span></section><button className="install-card" onClick={onInstall}><span className="install-icon">↥</span><span><strong>{installAvailable ? '添加到桌面' : '安装为桌面应用'}</strong><small>{installAvailable ? '一键安装，之后可随时打开' : '浏览器菜单中选择“安装应用”即可'}</small></span><span className="chevron">›</span></button><section className="section-heading section-heading--compact"><div><p className="eyebrow">训练偏好</p><h2>当前设置</h2></div></section><div className="settings-list"><SettingRow icon="◷" title="单次训练时长" value={`约 ${lastSession?.planTitle ? activePlanLabel(lastSession.planTitle) : '15 分钟'}`} /><SettingRow icon="⌁" title="训练重点" value="臀腿力量" /><SettingRow icon="◌" title="训练记录" value={lastSession ? formatDate(lastSession.completedAt) : '暂无记录'} /></div><section className="backup-card"><div><p className="eyebrow">LOCAL BACKUP</p><h2>资料备份</h2><p>把计划、训练日历和当前角色配置导出成一个 JSON 文件，可在另一台设备恢复。</p></div><div className="backup-actions"><button onClick={onExportBackup}>导出备份</button><button onClick={() => fileInput.current?.click()}>导入备份</button><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) onImportBackup(file); event.currentTarget.value = '' }} /></div></section><p className="muted-footnote">{storageReady ? '本机存储已就绪。训练时只播放计数，详细动作要领请点开动作详情。' : '正在准备本机存储。'}</p></div>
}

function activePlanLabel(title: string) { return title.includes('快速') ? '8 分钟' : title.includes('个人') ? '自定义' : '15 分钟' }

function CompleteScreen({ session, totalExercises, onAddRound, onBackHome }: { session: CompletedSession | null; totalExercises: number; onAddRound: () => void; onBackHome: () => void }) { const safe = session ?? { completedAt: new Date().toISOString(), rounds: 2, skipped: 0, estimatedCalories: 96 }; return <div className="page page-complete"><div className="completion-mark"><span>✓</span></div><p className="eyebrow">训练完成</p><h1>今天的你，<br /><em>很棒。</em></h1><p className="complete-subtitle">{session?.planTitle ?? '臀腿基础力量'} · {safe.rounds} 轮</p><div className="result-grid"><div><strong>{safe.estimatedCalories}</strong><span>估算消耗 · 千卡</span></div><div><strong>{safe.rounds}</strong><span>完成轮次</span></div><div><strong>{Math.max(0, totalExercises - safe.skipped)}</strong><span>完成动作</span></div></div><div className="completion-message"><span>✦</span><p>记得补充水分，给身体一点恢复时间。</p></div><button className="primary-button" onClick={onAddRound}>加练一轮 <span aria-hidden="true">+</span></button><button className="secondary-button secondary-button--wide" onClick={onBackHome}>回到首页</button></div> }

function ExerciseRow({ exercise, index, onOpen }: { exercise: Exercise; index: number; onOpen: (exercise: Exercise) => void }) { return <button className="exercise-row exercise-row--button" onClick={() => onOpen(exercise)}><div className={`exercise-index exercise-index--${exercise.targetTone}`}>{String(index + 1).padStart(2, '0')}</div><div className="exercise-row__body"><strong>{exercise.name}</strong><span>{exercise.equipment} · {exercise.target} · {exercise.reps} 次</span></div><span className="exercise-duration">{exercise.duration}</span><span className="row-chevron">›</span></button> }

function SettingRow({ icon, title, value }: { icon: string; title: string; value: string }) { return <div className="setting-row"><span className="setting-icon">{icon}</span><div><strong>{title}</strong><span>{value}</span></div><span className="chevron">›</span></div> }

function BottomNav({ activeTab, onChange }: { activeTab: Tab; onChange: (tab: Tab) => void }) { return <nav className="bottom-nav" aria-label="主导航">{(Object.keys(tabLabels) as Tab[]).map((tab) => <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => onChange(tab)}><span className="nav-icon">{tabIcons[tab]}</span><span>{tabLabels[tab]}</span></button>)}</nav> }

export default App
