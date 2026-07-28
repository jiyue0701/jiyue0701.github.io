export type Tab = 'home' | 'plan' | 'calendar' | 'profile'
export type Screen = 'home' | 'plan' | 'calendar' | 'detail' | 'workout' | 'complete' | 'profile'

export type VoiceChoice = {
  id: string
  label: string
  description: string
  uri?: string
  audioUri?: string
  playbackRate?: number
  status: 'preview' | 'ready'
}

export type Exercise = {
  id: string
  name: string
  equipment: '徒手' | '椅子辅助' | '哑铃'
  duration: string
  reps: number
  target: string
  muscleGroups?: string[]
  targetTone: 'coral' | 'plum' | 'gold'
  cue: string
  tips: string[]
  steps: string[]
  breathing: string
  reminders: string[]
  videoLabel: string
  videoStatus: 'approved'
  media: {
    posterUri?: string
    videoUri?: string
    motionId?: string
    videoStatus: 'approved'
    loopSeconds?: number
    voiceChoices: VoiceChoice[]
    coachingAudio?: {
      startUri?: string
      tipUri?: string
      countUris?: string[]
      countVariants?: string[][]
    }
  }
}

export type MotionPhase = {
  id: string
  start: number
  end: number
}

export type MotionCue = {
  time: number
  type: 'rep_checkpoint' | 'form_check'
}

export type MotionDefinition = {
  id: string
  exercise: string
  character: string
  assetType: 'video' | 'gif' | 'skeleton'
  intro?: string
  loop: string
  webm?: string
  mp4?: string
  frameUris?: string[]
  frameDurations?: number[]
  outro?: string
  poster: string
  width: number
  height: number
  fps: number
  loopDuration: number
  loopSeam: { startFrame: number; endFrame: number }
  phases: MotionPhase[]
  cues: MotionCue[]
  accessibility: { altText: string; captions?: string }
}

export type TrainingPlan = {
  id: string
  title: string
  subtitle: string
  duration: number
  rounds: number
  estimatedCalories: number
  source: 'preset' | 'personal'
  exercises: Exercise[]
}

export type CompletedSession = {
  completedAt: string
  rounds: number
  skipped: number
  estimatedCalories: number
  planTitle?: string
  exerciseCount?: number
}
