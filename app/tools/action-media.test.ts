import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const appRoot = process.cwd()
const publicRoot = join(appRoot, 'public')
const runtime = readFileSync(join(appRoot, 'src', 'workout', 'runtime.ts'), 'utf8')
const plan = readFileSync(join(appRoot, 'src', 'data', 'plan.ts'), 'utf8')
const app = readFileSync(join(appRoot, 'src', 'App.tsx'), 'utf8')
const detailManifest = JSON.parse(readFileSync(join(publicRoot, 'media', 'audio', 'detail', 'manifest.json'), 'utf8')) as { actions: Array<{ exerciseId: string; uri: string; sha256: string }> }
const motionCatalog = JSON.parse(readFileSync(join(appRoot, 'src', 'data', 'motion_catalog.json'), 'utf8')) as Array<{ id: string; exercise: string; video?: string; mp4?: string; webm?: string; poster?: string }>

const fixedActions = [
  { id: 'goblet-squat', poster: 'goblet-squat-poster.png' },
  { id: 'romanian-deadlift', poster: 'dumbbell-romanian-deadlift-poster.png' },
  { id: 'reverse-lunge', poster: 'reverse-lunge-poster.png' },
  { id: 'glute-bridge', poster: 'dumbbell-glute-bridge-poster.png' },
]

test('fixed workout keeps one-to-one action media mapping', () => {
  for (const [index, action] of fixedActions.entries()) {
    const block = runtime.slice(runtime.indexOf(`exerciseId: '${action.id}'`), runtime.indexOf(`exerciseId: '${fixedActions[index + 1]?.id ?? 'not-present'}'`))
    assert.match(block, new RegExp(`videoUri: '/media/actions/videos/${action.id}\\.mp4'`), `${action.id} video must use its own id`)
    assert.match(block, new RegExp(`videoFallbackUri: '/media/actions/videos/${action.id}\\.webm'`), `${action.id} WebM fallback must use its own id`)
    assert.match(block, new RegExp(`posterUri: '/media/actions/posters/${action.poster}'`), `${action.id} poster must use its own action`)
    const motion = motionCatalog.find((entry) => entry.id === `${action.id}.v1`)
    assert.equal(motion?.exercise, action.id, `${action.id} motion catalog entry must point back to the same exercise`)
    assert.equal(motion?.mp4, `/media/actions/videos/${action.id}.mp4`)
    assert.equal(motion?.webm, `/media/actions/videos/${action.id}.webm`)
  }
})

test('fixed workout exposes complete action-detail narration coverage', () => {
  assert.deepEqual(detailManifest.actions.map((item) => item.exerciseId), fixedActions.map((item) => item.id))
  for (const action of fixedActions) {
    const uri = `/media/audio/detail/${action.id}-detail.wav`
    assert.equal(existsSync(join(publicRoot, uri.slice(1))), true, `${uri} must be bundled`)
    assert.match(plan, new RegExp(`actionMedia\\('${action.id}',[^\\n]+${action.id}-detail\\.wav`), `${action.id} must declare its detail narration URI`)
    assert.equal(detailManifest.actions.find((item) => item.exerciseId === action.id)?.uri, uri)
  }
})

test('workout player remounts media when the exercise changes', () => {
  assert.match(app, /<video key=\{workoutExercise\.exerciseId\}/)
  assert.match(app, /data-exercise-id=\{workoutExercise\.exerciseId\}/)
  assert.match(app, /mediaReady && audioStatus === 'ready' && runtime\.state === 'idle'/)
})
