[English](./README.md) | [中文](./README_zh.md)

# Seedance 2.5 Prompt Skill

An open-source prompt-writing skill for ByteDance Jimeng/Dreamina **Seedance 2.5**. It turns rough ideas, scripts, storyboards, reference assets, and edit requests into structured Chinese prompts that are ready to paste into Seedance.

This project follows the repository layout and practical prompt-engineering spirit of [songguoxs/seedance-prompt-skill](https://github.com/songguoxs/seedance-prompt-skill), while updating the workflow for Seedance 2.5 using the [official Seedance 2.5 manual](https://bytedance.larkoffice.com/wiki/RXh5ww6EqighMdkVTMccm2d4n7e).

## Highlights

- Text-only, image-to-video, and full multimodal prompt writing.
- Native 4–30 second and ultra-long 30–180 second workflows.
- Second-level timestamp storyboarding for 30-second video.
- Video extension with continuity anchors.
- Smart edit, advanced edit, and generated-video edit prompts.
- White-model, green-screen, viewpoint, and local-region control.
- Multi-person identity, wardrobe, voice, and spatial consistency.
- Creative transfer, seamless transitions, multi-panel storyboards, and BGM removal.
- Prompt diagnosis and optimization.
- Claude Code-compatible skill folder plus OpenAI/Codex UI metadata.

## Project structure

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

`SKILL.md` contains the decision workflow and output contract. The reference files are loaded only when exact platform specifications or specialized prompt patterns are needed.

## Installation

### Claude Code — project skill

```bash
git clone https://github.com/xiaoliangliang/seedance-2.5-prompt-skill.git
mkdir -p /path/to/your-project/.claude/skills
cp -R seedance-2.5-prompt-skill/.claude/skills/seedance-2-5 \
  /path/to/your-project/.claude/skills/
```

### Claude Code — global skill

```bash
mkdir -p ~/.claude/skills
cp -R .claude/skills/seedance-2-5 ~/.claude/skills/
```

### Codex — global skill

```bash
mkdir -p ~/.codex/skills
cp -R .claude/skills/seedance-2-5 ~/.codex/skills/
```

Restart the agent after installation so it can discover the skill.

## Usage

Invoke it explicitly:

```text
Use $seedance-2-5 to write a 30-second vertical product launch video.
```

Or describe the task naturally:

```text
帮我写一个 Seedance 2.5 提示词：30 秒竖屏，两个角色在便利店重逢，
我有两张人物图、一张场景图和一段运镜参考视频。
```

The skill returns:

1. Recommended Seedance mode and settings.
2. A stable `@图片N` / `@视频N` / `@音频N` asset map.
3. One strongest copy-ready prompt.
4. Material preparation or UI notes when needed.

## Seedance 2.5 coverage

| Task | Prompt strategy |
| --- | --- |
| Basic generation | Asset description + overview + plot + global constraints |
| Realistic people | Concrete face, skin, eyes, hair, clothing, body, and mood |
| Native 30 seconds | Multimodal layer + global setup + timestamped screenplay |
| Ultra-long video | Global production rules + scene-level timeline |
| Video extension | Direction + duration + boundary anchor + continuation rules |
| Smart/advanced edit | Target + change + time range + preservation list |
| White-model control | Proxy mapping + blocking + action + camera + final rendering |

## Current official limits

The official guide checked on 2026-07-31 documents:

- Up to 30 reference images.
- Up to 10 reference videos, with combined duration no more than 30 seconds.
- Up to 10 reference audio clips, with combined duration no more than 30 seconds.
- Standard generation from 4 to 30 seconds.
- Ultra-long mode from 30 to 180 seconds.
- Video extension from a source no longer than 30 seconds, with up to 30 new seconds and a 60-second final maximum.
- 480p and 720p output settings in the documented interface.

Product limits may change. Verify the live Jimeng interface for production-critical work.

## Example

Input:

```text
我有一张女主图、一张江边场景图和一段音色参考，写一个30秒古装离别长镜头。
```

Output structure:

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

## Design decisions

- Use one primary prompt by default instead of producing several near-duplicates.
- Ask only questions that materially affect the result.
- Keep exact 2.5 specifications in a separate reference file to reduce context usage.
- Treat editing as a precise change request with explicit preservation constraints.
- Prefer native ultra-long mode for 30–180 seconds instead of the Seedance 2.0 workaround of splitting every long video into 15-second chunks.

## Sources and acknowledgements

- [Official Seedance 2.5 manual](https://bytedance.larkoffice.com/wiki/RXh5ww6EqighMdkVTMccm2d4n7e)
- [Jimeng / Dreamina](https://jimeng.jianying.com/)
- [songguoxs/seedance-prompt-skill](https://github.com/songguoxs/seedance-prompt-skill)

This is an independent community project and is not affiliated with or endorsed by ByteDance.

## License

[MIT](./LICENSE)
