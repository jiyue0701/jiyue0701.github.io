# 训练计数音频库

## 目标

- 训练过程中只播放数字计数，不播放整句动作解析、开场口令或重复提醒。
- 覆盖 1–40，满足高次数个人计划。
- 每个数字保留主版本和 v2 备用变体；播放器按计数节点轮换，避免每次都播放同一条音频。

## 当前状态

- 已使用本机 Qwen3-TTS Base，以参考声线生成 1–40，共 80 个 WAV。
- 生成使用单个常驻 `cuda:0 + bfloat16` worker；已加入 `NUMBA_DISABLE_CACHING=1`，绕过 Windows 上 librosa/numba 缓存导入卡死。
- 所有文件通过 WAV、单声道、非静音、过零率和时长检查后才复制到 `app/public/media/audio/`。
- 音频已去除 Qwen codec 产生的长尾静音，当前单条约 0.8–4.0 秒。
- App 的 `countUris` 和 `countVariants` 已接入 1–40；训练只在 `rep_checkpoint` 节点播放数字。

## 正式文件与替换规则

- 生成过程文件保留在本地忽略目录，不进入发布仓库。
- 正式清单：`app/public/media/audio/count-bank-manifest.json`
- 正式训练音频：`app/public/media/audio/count-low-01.wav` 至 `count-low-40.wav`，以及对应的 `-v2.wav`

如果后续主观试听发现某个数字的音色或咬字不理想，只替换对应数字及其 v2，不需要重新生成整个音频库。
