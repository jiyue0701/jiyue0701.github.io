# Initial Character Asset Triage｜2026-07-26

本记录基于当前项目中已有的候选图做资产分诊。它不是最终角色验收，也不把近似生成图升级为官方身份基准。

## 1. 分诊结果

| 文件 | 可保留用途 | 结论 | 原因 |
| --- | --- | --- | --- |
| `artifacts/2026-07-26/official-wriothesley-blend-views/official-blend-four-view-contact-sheet.png` | 官方模型身份/发型 Reference 2 | 通过为身份参考 | 多视角身份几何、发型和官方服装结构稳定；不承担健身教练身体比例和训练服装 |
| `artifacts/2026-07-26/official-character-candidates/candidate-C-portrait.png` | 官方模型脸部/上身观察 | 暂作脸部候选 | 脸部识别清楚，但仍带完整官方服装和渲染环境；需与独立脸部参考比较后才能成为 Reference 1 |
| `official_wriothesley_identity_baseline_00001_.png` | 官方身份/发型方向观察 | 参考保留 | 可观察黑蓝发、官方服装结构和角色轮廓；不能单独承担身体、服装状态和教练动作 |
| `wriothesley_identity_four_view_v1_00001_.png` | 发型、侧脸、四视图构图参考 | 参考保留 | 适合观察轮廓和发型分布；服装遮挡较强，不能作为训练体型或裸身状态参考 |
| `wriothesley_face_weighted_study_00001_.png` | 失败案例 | 驳回 | 脸部与身体出现明显噪声、结构破坏和视觉条件冲突，不能作为 `face_best` |
| `wriothesley_coach_canonical_00001_.png` | 失败案例/服装对照 | 驳回 | 白发、长外套、商务制服和角色识别发生明显漂移，不能作为身份或身体参考 |
| `wriothesley_shirtless_action_study_00001_.png` | 训练体型观察、动作构图观察 | 返工后再用 | 身体特写和动作构图有参考价值，但肌肉量偏大，发型/脸部/伤痕与身份基线不稳定，不能直接作为 `athletic_reference` |

## 2. 当前资产状态

```text
face_best.png             未冻结；candidate-C-portrait 暂作候选
official_front.png        通过为 Reference 2；优先使用 official-blend-four-view-contact-sheet
profile.png               通过为 Reference 2；优先使用 official-blend-four-view-contact-sheet
athletic_reference.png    未通过
shirtless_training_state  可作为状态方向，尚未锁定
```

## 3. 下一步处理

1. 不再重复使用 `wriothesley_face_weighted_study_00001_.png`；
2. 使用官方身份资料作为 Reference 2，先不让它承担身体比例；
3. 从可接受的成熟脸部参考中选出唯一 Reference 1；如果现有图片都不合格，就先补脸部参考，不继续生图碰运气；
4. 补一张自然功能型运动员体型 Reference 3，重点看肩背、腰线、胸腹和四肢比例，不追求健美比赛肌肉；
5. 按 [`shot-matrix-v1.0.md`](shot-matrix-v1.0.md) 做首轮 12 镜头小样本验证；
6. 只有脸、身体、服装状态和身体特写都通过后，才冻结训练数据集或启动 LoRA/Adapter。

## 4. 当前不可接受的做法

- 将 `wriothesley_shirtless_action_study_00001_.png` 直接当作最终角色；
- 将同一张脸部图重复输入以增加权重；
- 用长 prompt 掩盖参考图之间的身份冲突；
- 因为画面是身体特写就驳回素材；
- 在没有 Reference 3 的情况下，把“巨大胸肩/健美体型”写成身体基线。
