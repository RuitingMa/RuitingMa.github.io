---
title: 字的颗粒度
date: "2026-05-06"
kind: ESSAY
summary: Web 字体优化的标准做法几乎都是 Latin 答案的搬运，到中文这里每一步都要重答。
tint: dune
stage: stroke
---

<section data-cue="dust">

中文 web 排版的"标准做法"几乎都是 Latin 答案的搬运。woff2、unicode-range 切片、`font-display: swap`、preload。这套答案在拉丁文里成立，是因为它有几个隐含前提。把这些前提逐条列出来，会发现中文一个都不满足。

这篇笔记是把这些前提拆开重做的过程。每一步都不是"中文版的 Latin 答案"，是另一套答案。

</section>

<section data-cue="latin">

英文页面里，一段段落用到的字符几乎全在 Basic Latin（~95 字符）加几小块带音符的扩展区里。CSS 的 `unicode-range` 把字体按这些 Unicode 块切片，浏览器只下载本页 cmap 命中的片。一个典型页面只拉 ~10–30 KB。清爽、自动、无需后端。这是为什么这个答案会成为标准。

它成立靠一个隐含前提：字符集足够小、字符在 Unicode 里足够聚集。

</section>

<section data-cue="flood">

你正在读的这一段，不到 80 个汉字，跨了 CJK Unified、CJK Ext-A、有时再加 Compatibility 几块。把全套 Huiwen Mincho 切成 unicode-range 片，单页仍要拉接近全部 CJK 块——~15 MB，还多了几次 HTTP 请求。L3 切片对中文等于零优化。

问题不出在切法。出在尺度——把单元定在 unicode 范围这一层就太粗了。

</section>

<section data-cue="subset">

不问"这个字体多大"，问"这一页用了哪些字"。

Build 时扫每张 HTML 的可见文本，对每个字体做一次 subset，只保留 cmap 命中的字形。单页字体降到 ~50 KB。300 倍的缩减——不是"压缩"做出来的，是"颗粒度"换出来的。

写成代码：fontTools 的 `Subsetter`，丢掉 `hinting`、`GPOS`、`GSUB`、`MATH`、`kern` 这些不为中文 web 服务的表（每片再省 10–30%），输出 woff2。一个 Python 脚本接进 Astro 的 `astro:build:done` 钩子，build 多花 2.4 秒。

</section>

<section data-cue="common">

单页解决了，跨页又冒出来：换页要不要重下一遍？

把"≥2 个页面用过"的字符并入 common pool，独占字进 per-page extras。Common 一进缓存就跨页复用，extras 只补差。整站全部部署 ~105 KB——比一个 woff2 单文件还小。

读者点下一篇，浏览器从 cache 取 common，从网络补几 KB 的 extras。几乎察觉不到字体在加载。

</section>

<section data-cue="swap">

字节问题解决了，视觉问题还没。`font-display` 三选项：

- `swap`：到了立即换 → 跳一下（FOUT）
- `fallback`：短 block，超时 swap → 还是跳
- `optional`：~100ms 没到就这次别换了，下次再说 → 不跳

选 `optional` 是审美决定，不是性能决定。

再加一层：fallback 的系统字体声明 `ascent-override` / `descent-override` / `line-gap-override`，让它和真字体占同一个 line-box。即使下一次换了，也不跳。CLS 压到接近零。

</section>

<section data-cue="pool">

Sketch 用 `ctx.fillText` 画字，浏览器只在本页 subset 里找字形——没有就静默 fallback 到系统字体。运行时随机拼字、过程式造文本的 sketch 会偷偷换装，肉眼看不太出但字形错了。

解决法：任意元素挂 `data-font-pool="眠海潮汐..."`，build 扫 HTML 时把这串字符并进当页 subset。声明式、构建期、零运行时开销。是把"sketch 私有的字符需求"翻译成 build 能看见的语言。

</section>

<section data-cue="recap">

实测：3 页站点，总字体部署 ~105 KB（common 28 + extras 77），单页首屏 40–100 KB，build 多 2.4 秒。对比 Latin 答案的"单文件 woff2"约 30 MB，差 300 倍。

工具（fontTools、CSS `@font-face`、`font-display`）是通用的。尺度是中文给的。

</section>
