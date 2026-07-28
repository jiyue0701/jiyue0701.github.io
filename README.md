# 莱欧斯利训练教练 · Personal Fitness Coach

一个面向个人学习与训练的本地优先健身 Web App 原型。角色基准是风格化 3D 动漫游戏渲染的莱欧斯利训练教练；训练内容采用固定机位、可复用动作素材和纯数字节拍音频，避免每次训练重新生成媒体。

## 已完成的产品能力

- 首页：角色锁定状态、今日训练、角色靠右构图，文字区不遮挡人物。
- 计划：按肌群一级分类，再按徒手 / 椅子辅助 / 哑铃二级筛选。
- 计划库：现成计划可添加到个人库；个人计划支持套用、改名、修改动作、删除和手动新增。
- 动作详情：步骤、呼吸、目标肌群、动作要领、常见错误、关键帧验收标准。
- 训练：默认自动播放动作媒体和数字计数；只有跳过、暂停、退出等必要操作，动作结束后自动进入下一项或休息占位页。
- 日历与备份：训练完成状态日历、JSON 导出和导入，数据保存在浏览器本地。
- PWA：包含 manifest 和 service worker，可在支持的浏览器中安装到桌面或主屏幕。

## 素材验收结果

| 素材 | 数量 | 状态 |
| --- | ---: | --- |
| 动作目录 | 28 | 已接入 |
| 动作海报 | 28 PNG | 已接入 |
| 动作视频 | 28 WebM + 28 MP4 | 30 FPS，已接入 |
| 动作关键帧 | 59 PNG | 固定机位；左右动作使用专用帧 |
| 数字计数音频 | 1–40 × v1/v2 | 80 WAV，纯数字，已通过 ASR 闸门 |

训练音频不再朗读动作长句、鼓励语或“你将自律”等额外内容；只在已定义的动作 checkpoint 播放一个数字，数字范围可覆盖高次数训练。

## 本地运行

需要 Node.js 20+ 与 pnpm。进入 `app`：

```powershell
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1 --port 5173
```

打开 `http://127.0.0.1:5173/?view=home`。生产构建：

```powershell
pnpm build
pnpm preview --host 127.0.0.1 --port 4173
```

Windows 本地也可以运行 `app/start-training-app.ps1`，脚本会检查服务、启动 Vite 并打开首页。

## 质量检查

在项目根目录运行：

```powershell
$py = 'work/2026-07-25/cuda13-runtime/venv/Scripts/python.exe'
& $py tools/validate_motion_assets.py
& $py tools/validate_app_assets.py
pnpm --dir app build
```

两个素材验证器均应输出 `approved`，构建应无 TypeScript 或 Vite 错误。生成过程目录、模型、候选文件、缓存和本地依赖均被 `.gitignore` 排除；发布仓库只包含 App、正式素材、文档和验证脚本。

## GitHub Pages

仓库包含 `.github/workflows/deploy-pages.yml`。推送 `main` 后，GitHub Actions 会构建 `app/dist` 并部署 Pages。项目按用户站点仓库 `Panguiii.github.io` 配置，正式地址为：

<https://panguiii.github.io/>

如果改用项目站点仓库，需要同步调整 Vite `base` 与媒体路径；当前版本使用用户站点根路径，保证 `/media/...` 素材路径在手机浏览器中可用。

## 资料与目录

- `app/`：React + Vite Web App 与正式运行素材。
- `docs/`：角色 Bible、动作复用规范、语音计数规范、产品验收记录。
- `content/`：动作和计划的结构化内容清单。
- `tools/`：动作素材、音频和 App 资源验证脚本。
- `audit/product-audit/`：基于首页、计划页、训练页实际运行截图的产品体验审查。

素材只使用本项目生成或整理的资产；外部动作页面仅用于动作研究和来源追溯，不复制其视频、图片或音频。
