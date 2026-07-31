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
const motionCatalog = JSON.parse(readFileSync(join(appRoot, 'src', 'data', 'motion_catalog.json'), 'utf8')) as Array<{ id: string; exercise: string; video?: string; mp4?: string; webm?: string; poster?: string; loopDuration?: number }>
const catalogSource = plan.slice(0, plan.indexOf('export const planPresets'))
const catalogExerciseIds = [...catalogSource.matchAll(/\n    id: '([^']+)'/g)].map((match) => match[1])

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
  assert.equal(detailManifest.actions.length, catalogExerciseIds.length)
  assert.deepEqual(new Set(detailManifest.actions.map((item) => item.exerciseId)), new Set(catalogExerciseIds))
  for (const action of fixedActions) {
    const uri = `/media/audio/detail/${action.id}-detail.wav`
    assert.equal(existsSync(join(publicRoot, uri.slice(1))), true, `${uri} must be bundled`)
    assert.match(plan, new RegExp(`actionMedia\\('${action.id}',[^\\n]+${action.id}-detail\\.wav`), `${action.id} must declare its detail narration URI`)
    assert.equal(detailManifest.actions.find((item) => item.exerciseId === action.id)?.uri, uri)
  }
  for (const exerciseId of catalogExerciseIds.filter((id) => !fixedActions.some((action) => action.id === id))) {
    const uri = `/media/audio/detail/${exerciseId}-detail.wav`
    assert.equal(existsSync(join(publicRoot, uri.slice(1))), true, `${uri} must be bundled`)
    assert.ok(plan.includes(`assetMedia('${exerciseId}')`) || plan.includes(`actionMedia('${exerciseId}',`), `${exerciseId} must resolve its detail narration URI`)
    assert.equal(detailManifest.actions.find((item) => item.exerciseId === exerciseId)?.uri, uri)
  }
})

test('core action posters keep the full-resolution masters', () => {
  const posterFiles = [
    'goblet-squat-poster.png',
    'dumbbell-romanian-deadlift-poster.png',
    'reverse-lunge-poster.png',
    'dumbbell-glute-bridge-poster.png',
    'bodyweight-squat-poster.png',
    'bodyweight-glute-bridge-poster.png',
    'chair-sit-to-stand-poster.png',
    'chair-assisted-split-squat-poster.png',
    'dumbbell-reverse-lunge-poster.png',
  ]
  for (const file of posterFiles) {
    const bytes = readFileSync(join(publicRoot, 'media', 'actions', 'posters', file))
    assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `${file} must remain a PNG master`)
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    assert.ok(width >= 900 && height >= 1500, `${file} must not regress to the 360×640 preview`)
  }
})

test('goblet squat keeps a high-resolution continuous loop and fallback frame', () => {
  for (const action of fixedActions) {
    const mp4 = readFileSync(join(publicRoot, 'media', 'actions', 'videos', `${action.id}.mp4`))
    const webm = readFileSync(join(publicRoot, 'media', 'actions', 'videos', `${action.id}.webm`))
    assert.ok(mp4.length > 1_000_000, `${action.id} MP4 must not regress to the tiny low-resolution loop`)
    assert.ok(webm.length > 500_000, `${action.id} WebM fallback must remain a full-resolution loop`)
  }
  const peak = readFileSync(join(publicRoot, 'media', 'actions', 'frames', 'goblet-squat-peak.png'))
  assert.equal(peak.toString('ascii', 1, 4), 'PNG')
  assert.ok(peak.readUInt32BE(16) >= 900 && peak.readUInt32BE(20) >= 1500, 'goblet squat fallback frame must remain a full-resolution master')
})

test('core action cycles match their motion-catalog loop contracts', () => {
  const expected = new Map([['goblet-squat', 4.5], ['romanian-deadlift', 4.5], ['reverse-lunge', 6], ['glute-bridge', 3]])
  for (const [exerciseId, seconds] of expected) {
    const motion = motionCatalog.find((entry) => entry.exercise === exerciseId)
    assert.equal(motion?.loopDuration, seconds, `${exerciseId} catalog loop must match its runtime cycle`)
    const blockStart = runtime.indexOf(`exerciseId: '${exerciseId}'`)
    const blockEnd = runtime.indexOf('    },', blockStart)
    const block = runtime.slice(blockStart, blockEnd)
    assert.match(block, new RegExp(`cycleDurationMs: ${Math.round(seconds * 1000).toLocaleString('en-US').replace(/,/g, '_')}`))
  }
})

test('abdominal preset is visible and uses matched core assets', () => {
  assert.match(plan, /id: 'core-shredder-foundation-v0-1'/)
  for (const exerciseId of ['dead-bug', 'forearm-plank', 'chair-knee-raise', 'seated-chair-march']) {
    assert.match(plan, new RegExp(`'${exerciseId}'`), `${exerciseId} must be part of the catalog`)
    assert.ok(existsSync(join(publicRoot, 'media', 'actions', 'posters', `${exerciseId}-poster.png`)))
    assert.ok(existsSync(join(publicRoot, 'media', 'actions', 'videos', `${exerciseId}.mp4`)))
  }
})

test('workout player remounts media when the exercise changes', () => {
  assert.match(app, /<video key=\{workoutExercise\.exerciseId\}/)
  assert.match(app, /data-exercise-id=\{workoutExercise\.exerciseId\}/)
  assert.match(app, /motion-player__video-slot--landscape/)
  assert.match(readFileSync(join(appRoot, 'src', 'styles.css'), 'utf8'), /motion-player__video-slot > video[^\n]*object-fit: contain/)
  assert.match(app, /mediaReady && audioStatus === 'ready' && runtime\.state === 'idle'/)
})
