import type { VoiceChoice } from '../types'

export const characterAssets = {
  id: 'wriothesley-coach',
  displayName: '莱欧斯利训练教练',
  identityStatus: 'locked',
  lockSheetUri: '/media/character-lock-sheet.png',
  actionPosterUri: '/media/goblet-squat-setup.png',
  earOrnament: '左右各一只毛茸茸的黑灰色兽耳装饰；保留正常人耳',
  neck: '黑色颈带，无项链',
  mediaFallback: '动作画面与数字计数已预渲染，训练中自动同步播放',
} as const

export const voiceChoices: VoiceChoice[] = [
  {
    id: 'low',
    label: '低沉版 · 已锁定',
    description: '训练只播放低沉数字计数；当前 1–40 主版本与 v2 备用变体已接入。',
    audioUri: '/media/audio/count-low-01.wav',
    playbackRate: 0.96,
    status: 'ready',
  },
]
