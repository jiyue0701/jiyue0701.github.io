# 动作素材管线 v1

当前动作素材采用“固定机位逐帧演示 + WebM 优先回退”的过渡结构：

- `app/public/media/actions/frames/` 保存同一机位下的动作关键帧，背景、地面和人物落点保持一致。
- `motion_catalog.json` 通过 `frameUris` 描述状态序列；播放器逐帧切换，不做整帧镜像，也不做透明叠加，因此不会出现重影背景。
- `MotionPlayer` 使用正式 `webm`，并提供 `mp4` 作为浏览器兼容回退；关键帧用于海报和动作详情验收。
- `phases` 和 `cues` 仍由动作状态机驱动，媒体帧只是表现层；计时、计数和语音不会被视频实际帧数绑架。
- 左右交替动作使用独立的左右关键帧，共享同一背景，不镜像整张画面。

正式素材目录约定：

```text
app/public/media/actions/<action>/
  intro.webm
  loop.webm
  outro.webm
  poster.png
```

正式 30 FPS WebM/MP4 已接入 `motion_catalog.json`；关键帧保留作海报、动作详情和素材验收，不把稀疏图片序列伪装成视频。
