# 角色形象评估｜2026-07-26

## 结论

当前采用“线上候选负责身份探索，页面只接入单独通过验收的媒体；本地模型不承担最终身份或视频”的分工。

本地 FLUX.2 Klein 4B Distilled 可以快速跑通参考编辑，但不适合承担当前角色的最终脸部和皮肤基准。连续两次本地结果都出现高光爆亮、过饱和、线稿化、皮肤块面和肌肉夸张，且无法稳定理解“保留人耳、头发上有兽耳形装饰”。继续增加本地样本只会增加返工，不进入下一阶段。

## 参考图分工

| 参考 | 负责 | 不负责 |
| --- | --- | --- |
| 图1：`codex-clipboard-c12c1524-2cd7-49e1-bdb2-a95cdfbc6829.png` | 脸部画风、五官比例、眼型、成熟表情、皮肤渲染语言 | 身体比例、坐姿、服装和构图 |
| 图2：`codex-clipboard-c3244b48-0b9d-45eb-81b5-48313f9fc602.png` | 身体、坐姿、正式造型、颈饰、腰部细节、构图、发型上的兽耳形装饰 | 脸部画风、脸型、皮肤质感 |

关键规则：图1优先决定脸。图2的脸部不能回灌到身份层，否则会出现半写实三维脸与动漫游戏脸混合。

## 本轮候选

| 文件 | 判断 | 原因 |
| --- | --- | --- |
| `candidate-08-local-face-skin-hair-ornament-revision.png` | reject | 本地结果过饱和、线稿化、皮肤与身体失真 |
| `candidate-09-local-face-skin-hair-ornament-revision.png` | reject | 与上一张相同的本地模型缺陷，未形成稳定画风 |
| `candidate-10-online-human-ear-hair-ornament-finalist.png` | reject | 画面质量较好，但脸部变成半写实风，与图1不属于同一画风 |
| `candidate-11-face-style1-body-context2.png` | provisional pass | 脸部回到图1画风；身体、坐姿、服装和发饰采用图2语境；待多视角验证 |

## 当前基准

上一轮主候选已被用户否决其脸部整合效果，不再作为 Web App 或动作视频身份基准：

`D:\codex\projects\视频大模型\artifacts\2026-07-26\character-candidates\candidate-v5-first-group-feel-texture-normalized-fullbody.png`

它保留为身体、场景和构图研究素材，但当前问题是“身体是身体、头是头”，脸和身体没有形成连续的同一角色资产。

新生成的 `face-v6-official-mature-furry-ear-ornament.png` 也只保留为脸部研究候选，不能当作已通过的全身角色图；它与身体的连续性仍未通过。页面开发因此采用“角色媒体槽位”，不展示被否决的候选。

当前结论：角色身份基准未确认，暂停 LoRA 和角色视频生成；产品页面、动作内容、语音口令接口和媒体接入位继续开发。

### 最新候选 v8

`D:\codex\projects\视频大模型\artifacts\2026-07-26\character-candidates\candidate-v8-official-face-reduced-traps.png`

本次以 v7 作为整体连续性基础，再用官方立绘只修正脸部与发型，并降低斜方肌和颈肩厚度。初步检查：头身连续性比 v5/v6 更好，斜方肌没有继续放大；黑灰发色、浅暖肤色、毛茸茸耳饰、黑色颈带和健身房光影保持。该图仍是待用户验收候选，不进入 Web App 或动作视频。

多视图锁定集见：

`D:\codex\projects\视频大模型\docs\character\character-lock-set-v5-20260726.md`

当前新增的硬规则：颈部只保留黑色颈带，不再使用项链、吊坠或链条；任何头身不连续的候选不得进入页面主视觉。

## 安全/验收口径

本轮没有新增项目限制。裸露上身、身体特写、训练短裤和当前正式造型继续允许；核心阻断项仍只保留：全裸、暴露生殖器、女性化身份漂移、武器与束缚情趣配饰。
