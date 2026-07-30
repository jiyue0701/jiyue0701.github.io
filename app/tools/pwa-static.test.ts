import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const appRoot = process.cwd()
const publicRoot = join(appRoot, 'public')

function pngDimensions(filename: string) {
  const data = readFileSync(join(publicRoot, filename))
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${filename} must have a PNG signature`)
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

test('Profile PWA path uses accessible Phosphor icons without text glyph placeholders', () => {
  const app = readFileSync(join(appRoot, 'src', 'App.tsx'), 'utf8')
  const profileSource = app.slice(app.indexOf('function ProfileScreen'), app.indexOf('function activePlanLabel'))
  const settingRowSource = app.slice(app.indexOf('function SettingRow'), app.indexOf('function BottomNav'))
  const guardedSource = `${profileSource}\n${settingRowSource}`

  assert.doesNotMatch(guardedSource, /[✓↥›◷⌁◌]/)
  for (const icon of ['Check', 'DownloadSimple', 'DeviceMobile', 'CaretRight', 'Clock', 'Target', 'CalendarDots']) {
    assert.match(profileSource, new RegExp(`<${icon}\\b`), `ProfileScreen must render ${icon}`)
  }
  assert.match(settingRowSource, /icon: ReactNode/)
  assert.match(settingRowSource, /<CaretRight\b/)
  assert.doesNotMatch(guardedSource, /className="(?:install-icon|chevron|setting-icon)"(?! aria-hidden="true")/)
})

test('voice-led workout cues and refresh path are shipped with native video masters', () => {
  const app = readFileSync(join(appRoot, 'src', 'App.tsx'), 'utf8')
  for (const filename of [
    'preparation.wav',
    'start.wav',
    'action-01-goblet-squat.wav',
    'action-02-romanian-deadlift.wav',
    'action-03-reverse-lunge.wav',
    'action-04-glute-bridge.wav',
  ]) assert.equal(existsSync(join(publicRoot, 'media', 'audio', 'guidance', filename)), true, `${filename} must be bundled`)
  assert.match(app, /preparation: '\/media\/audio\/guidance\/preparation\.wav'/)
  assert.match(app, /onSegmentStart:/)
  assert.match(app, /refreshApp/)
  assert.match(app, /videoUri\.endsWith\('\.mp4'\)/)
})

test('manifest provides separate standard any and maskable PNG icons', () => {
  const manifest = JSON.parse(readFileSync(join(publicRoot, 'manifest.webmanifest'), 'utf8')) as {
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>
  }
  assert.deepEqual(manifest.icons, [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ])
})

test('generated icons have valid PNG signatures and exact dimensions', () => {
  assert.deepEqual(pngDimensions('icon-192.png'), { width: 192, height: 192 })
  assert.deepEqual(pngDimensions('icon-512.png'), { width: 512, height: 512 })
  assert.deepEqual(pngDimensions('icon-maskable-512.png'), { width: 512, height: 512 })
  assert.deepEqual(pngDimensions('apple-touch-icon.png'), { width: 180, height: 180 })
})

test('index exposes Apple touch icon and standalone metadata', () => {
  const html = readFileSync(join(appRoot, 'index.html'), 'utf8')
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png"/)
  assert.match(html, /name="mobile-web-app-capable" content="yes"/)
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/)
})

test('manifest shortcuts describe fixed v2 workout and save-only personal lists', () => {
  const manifestText = readFileSync(join(publicRoot, 'manifest.webmanifest'), 'utf8')
  assert.match(manifestText, /固定四动作、三轮、约 14:20/)
  assert.match(manifestText, /整理并保存个人动作清单，不会替代固定跟练计划/)
  assert.doesNotMatch(manifestText, /直接打开当前训练计划/)
})

test('App statically covers standalone, iOS, appinstalled, and Chromium install events', () => {
  const app = readFileSync(join(appRoot, 'src', 'App.tsx'), 'utf8')
  assert.match(app, /display-mode: standalone/)
  assert.match(app, /NavigatorWithStandalone/)
  assert.match(app, /\.standalone/)
  assert.match(app, /appinstalled/)
  assert.match(app, /beforeinstallprompt/)
  assert.match(app, /Safari 点“分享”，再选择“添加到主屏幕”/)
  assert.match(app, /已安装到桌面/)
})
