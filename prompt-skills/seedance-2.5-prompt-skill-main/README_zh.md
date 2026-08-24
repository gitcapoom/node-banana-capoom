[English](./README.md) | [中文](./README_zh.md)

# Seedance 2.5 视频提示词 Skill

一个面向字节跳动即梦 / Dreamina **Seedance 2.5** 的开源提示词写作 Skill。它可以把一句创意、脚本、分镜、参考素材清单或视频修改需求，整理成结构清晰、可直接复制到即梦使用的中文提示词。

本项目沿用 [songguoxs/seedance-prompt-skill](https://github.com/songguoxs/seedance-prompt-skill) 简洁清晰的仓库组织方式和实用写法，并依据[官方 Seedance 2.5 使用手册](https://bytedance.larkoffice.com/wiki/RXh5ww6EqighMdkVTMccm2d4n7e)重写 2.5 的参数、模式和提示词工作流。

## 功能

- 纯文本、图生视频、全能参考等多模态提示词。
- 4–30 秒原生视频与 30–180 秒超长视频。
- 30 秒视频的秒级时间戳分镜。
- 带衔接锚点和连续性约束的视频延长。
- 智能编辑、高级编辑、视频编辑提示词。
- 白模、绿幕、空间视角和局部区域控制。
- 多人物身份、服装、音色与空间关系一致性。
- 创意迁移、无缝转场、多宫格分镜、BGM 移除。
- 现有提示词诊断、改写和压缩。
- 支持 Claude Code 的目录结构，并带 Codex/OpenAI UI 元数据。

## 仓库结构

```text
.
├── .claude/
│   └── skills/
│       └── seedance-2-5/
│           ├── SKILL.md
│           ├── agents/
│           │   └── openai.yaml
│           └── references/
│               ├── official-guide.md
│               └── prompt-patterns.md
├── .gitattributes
├── .gitignore
├── LICENSE
├── README.md
└── README_zh.md
```

`SKILL.md` 只保存核心决策流程与输出规范；精确的平台参数和场景模板放在 `references/`，需要时再加载，减少上下文占用。

## 安装

### Claude Code：项目级 Skill

```bash
git clone https://github.com/xiaoliangliang/seedance-2.5-prompt-skill.git
mkdir -p /path/to/your-project/.claude/skills
cp -R seedance-2.5-prompt-skill/.claude/skills/seedance-2-5 \
  /path/to/your-project/.claude/skills/
```

### Claude Code：全局 Skill

```bash
mkdir -p ~/.claude/skills
cp -R .claude/skills/seedance-2-5 ~/.claude/skills/
```

### Codex：全局 Skill

```bash
mkdir -p ~/.codex/skills
cp -R .claude/skills/seedance-2-5 ~/.codex/skills/
```

安装后重启 Agent，使其重新发现 Skill。

## 使用方法

显式调用：

```text
使用 $seedance-2-5 帮我写一个30秒竖屏新品发布视频。
```

也可以自然描述需求：

```text
帮我写一个 Seedance 2.5 提示词：30秒竖屏，两个角色在便利店重逢，
我有两张人物图、一张场景图和一段运镜参考视频。
```

Skill 默认会输出：

1. 推荐的 Seedance 模式、时长、比例和分辨率。
2. 稳定的 `@图片N` / `@视频N` / `@音频N` 素材映射。
3. 一版质量最强、可直接复制的提示词。
4. 必要的素材准备或界面操作提示。

## Seedance 2.5 提示词覆盖

| 任务 | 核心公式 |
| --- | --- |
| 基础生成 | 素材说明 + 一句话概述 + 情节动作 + 全局补充 |
| 写实人物 | 年龄人种 + 皮肤 + 五官 + 眼神 + 发型 + 服装 + 体型气质 |
| 原生 30 秒 | 多模态参考层 + 全局设定 + 时间戳剧本分镜 |
| 超长视频 | 全局制作规则 + 场景级时间线 + 明确转场 |
| 视频延长 | 方向时长 + 边界状态 + 新内容 + 连续性约束 |
| 智能/高级编辑 | 修改对象 + 变化 + 生效时段 + 保持不变项 |
| 白模控制 | 代理映射 + 站位动作 + 运镜 + 场景 + 成片质感 |

## 当前官方参数

根据 2026-07-31 核对的官方手册：

- 最多 30 张参考图片。
- 最多 10 段参考视频，总时长不超过 30 秒。
- 最多 10 段参考音频，总时长不超过 30 秒。
- 常规生成时长 4–30 秒。
- 超长视频模式 30–180 秒。
- 视频延长要求原视频不超过 30 秒，单次可新增最多 30 秒，最终成片最长 60 秒。
- 官方手册当前列出的输出选项为 480p、720p。

平台会继续更新；生产任务请以即梦实时界面为准。

## 示例

输入：

```text
我有一张女主图、一张江边场景图和一段音色参考，写一个30秒古装离别长镜头。
```

输出结构：

```text
推荐模式：全能参考
时长：30秒
比例：2.35:1

@图片1：女主身份、发型和服装
@图片2：江边场景、薄雾和光线
@音频1：女主音色、语速和克制情绪

《最后一班渡船》，30秒，2.35:1，写实东方电影感……
0–6秒：……
6–13秒：……
……
```

## 设计取舍

- 默认只给一版最强提示词，避免输出多个高度重复的版本。
- 只有当缺失信息会明显改变结果时才追问。
- 把易变化的 2.5 精确参数放在独立参考文件中。
- 把视频编辑写成“精准修改 + 明确保留”的手术式指令。
- 30–180 秒优先使用 2.5 原生超长视频，不再沿用 2.0 “所有长视频都拆成 15 秒”的旧方案。

## 资料与致谢

- [Seedance 2.5 官方使用手册](https://bytedance.larkoffice.com/wiki/RXh5ww6EqighMdkVTMccm2d4n7e)
- [即梦 / Dreamina](https://jimeng.jianying.com/)
- [songguoxs/seedance-prompt-skill](https://github.com/songguoxs/seedance-prompt-skill)

本项目为独立社区项目，与字节跳动不存在隶属或官方背书关系。

## 许可证

[MIT](./LICENSE)
