# 字体管道 · Font Pipeline

> 每页只下载自己用到的字，总部署 ~200 KB，单页首屏 ~90 KB。
> Level 4 per-page subsetting + shared common pool + preload/prefetch。

---

## TL;DR

- **Active faces 由 [src/styles/tokens.css](../src/styles/tokens.css) 自动推导**：只要 `var(--font-*)` fallback 链里出现 `'Huiwen X'` 字面量，该 face 就会被处理；否则跳过。
- 首次克隆后做两件事：
  ```bash
  pip install fonttools brotli
  python scripts/build-fonts.py dev
  ```
- 之后：
  - `npm run dev` → 读 `public/fonts-dev.css` + `public/fonts/dev/*.woff2`（单文件 WOFF2 做 fallback）。
  - `npm run build` → Astro 先建站，[`integrations/font-subset.mjs`](../integrations/font-subset.mjs) 在 `astro:build:done` 时调 [`scripts/build-fonts.py pages dist/`](../scripts/build-fonts.py)；这一步扫 HTML 文本、做 per-page subset、把 `<link rel="preload">` + `<style>` + `<link rel="prefetch">` 塞进每个 HTML 的 `<head>`。

---

## 架构

### 两条路径

```
                  src/assets/fonts/*.ttf  (source, ~90 MB total)
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
   python build-fonts.py dev        astro build → integration
   (manual, one-time)               (automatic, every build)
          │                                 │
   public/fonts/dev/*.woff2         dist/fonts/p/common/*.woff2
   public/fonts-dev.css             dist/fonts/p/<hash>/*.woff2
          │                         <style>@font-face ...</style>
   dev server reads via             injected into each dist/**/*.html
   <link href="/fonts-dev.css">
```

### 核心约定

1. **字体族名是契约边界**：组件永远只写 `font-family: var(--font-display)` 这种引用。`@font-face` 的 `src:` URL 是什么文件、放哪个目录，只有 `build-fonts.py` 知道。所有优化都只改 build 产物，页面/组件代码永远不动。
2. **Active face 单一数据源**：`tokens.css` 里引用到的 `'Huiwen X'` 就是 active，其他一律 dormant。添加或移除一个字体只改这一个文件。
3. **Dev / Prod 两段**：dev 用完整 WOFF2 图省事；prod 用 per-page subset 图性能。BaseLayout 里 `{import.meta.env.DEV && <link ...>}` 做切换，prod HTML 里那行被静态消去。

---

## 文件清单

| 路径 | 角色 | 手写 or 生成 |
|---|---|---|
| [src/assets/fonts/*.ttf](../src/assets/fonts/) | 源 TTF（不部署，可 gitignore） | 手放 |
| [src/styles/tokens.css](../src/styles/tokens.css) | `--font-*` CSS 变量，**active face 的唯一来源** | 手写 |
| [src/styles/fonts.css](../src/styles/fonts.css) | 占位注释，不再 import | 手写 |
| [src/layouts/BaseLayout.astro](../src/layouts/BaseLayout.astro) | dev 模式下条件链 `fonts-dev.css` | 手写 |
| [public/fonts-dev.css](../public/fonts-dev.css) | dev 用的 `@font-face` | **由 `build-fonts.py dev` 生成** |
| [public/fonts/dev/*.woff2](../public/fonts/dev/) | dev 单文件 WOFF2 | **由 `build-fonts.py dev` 生成** |
| [scripts/build-fonts.py](../scripts/build-fonts.py) | 字体引擎（两子命令） | 手写 |
| [integrations/font-subset.mjs](../integrations/font-subset.mjs) | Astro hook，调 Python | 手写 |
| [astro.config.mjs](../astro.config.mjs) | 接入 integration | 手写 |
| `dist/fonts/p/common/*.woff2` | prod 共享 subset（≥2 页共用字符） | **build 时生成** |
| `dist/fonts/p/<10位hash>/*.woff2` | prod 单页 extras | **build 时生成** |
| `dist/**/*.html` | preload + `<style>` + prefetch 注入 | **build 时修改** |
| [scripts/read-font-license.mjs](../scripts/read-font-license.mjs) | 读 TTF `name` 表的诊断脚本（一次性用） | 手写 |

---

## 日常流程

### 第一次克隆

```bash
# Python 依赖（不会被 Astro 打包，只是 build 时用）
pip install fonttools brotli

# 确认 src/assets/fonts/ 里有 4 个汇文 TTF
# 来源是本地用户字体目录（Windows: %LOCALAPPDATA%\Microsoft\Windows\Fonts\）
# 若缺失，需要先拷过来：
#   huiwen-mincho.ttf ← 匯文明朝體GBK.ttf
#   huiwen-kaiti.ttf ← 匯文正楷.ttf
#   huiwen-fangsong.ttf ← 匯文仿宋.ttf
#   huiwen-hkhei.ttf ← 匯文港黑.ttf

# 生成 dev 用的字体（~2 分钟，处理所有 active face）
python scripts/build-fonts.py dev

# Astro 依赖
npm install
```

### 改内容后

- 改 Markdown / 组件 / CSS → 什么都不用做，正常 `npm run dev` / `npm run build`。
- 改 `tokens.css` 把某 face 加进或拿出 fallback 链 → **必须重新跑一次 `python scripts/build-fonts.py dev`**，否则 dev 模式会缺字体或带多余 face。`npm run build` 自动跟上（integration 每次都读最新 tokens.css）。
- 改 `src/assets/fonts/*.ttf`（替换字体文件） → 跑 `python scripts/build-fonts.py dev` 刷 dev 产物。

### 添加一个新字体

1. TTF 放到 `src/assets/fonts/huiwen-<name>.ttf`
2. 在 [`scripts/build-fonts.py`](../scripts/build-fonts.py) 的 `ALL_FACES` 列表里加一行 `("huiwen-<name>.ttf", "Huiwen <Name>", "<slug>")`
3. 在 `tokens.css` 的 `--font-*` fallback 链里写 `'Huiwen <Name>'`（这步把它激活）
4. `python scripts/build-fonts.py dev` 刷 dev

### 移除一个字体

- 只要从 `tokens.css` 的 fallback 链里删掉 `'Huiwen X'` 就行。`ALL_FACES` 里可以留着，TTF 可以留着——active 检测会跳过，build 一点都不处理它。
- 彻底清理再删 `ALL_FACES` 条目和 TTF 文件。

---

## 扩展点

### `data-font-pool` —— 程序化生成中文的 canvas sketch

Canvas 的 `ctx.fillText` 只会使用当前页 subset 里有的字形。如果 sketch 在运行时随机挑字、拼句、动态造文字，那些字可能不在静态 HTML 里，subset 就没它们 → canvas 默默 fallback 到系统字体，形状错了。

解决办法：在任意元素挂 `data-font-pool="字符串"`，Python 扫 HTML 时会把这些字符并入该页的 subset。

```html
<div class="sketch" data-font-pool="眠海潮汐春夏秋冬一二三四五六七八九十">
  <canvas ...></canvas>
</div>
```

可以挂多次，内容会自动并集。空间便宜得很，尽管放。

### SVG glyph 提取（未实现，接口已留）

如果要让主页 "眠海" 两字零延迟首屏（既不等字体也不会 fallback），可以把这两个字的字形从 Mincho 提成 SVG `<path>` 内联到 HTML。需要给 `build-fonts.py` 加一个 `glyphs "<chars>" <face>` 子命令，输出 SVG，theme 侧 import 即可。未实现，但是和现架构兼容，加 30 行代码可用。

### Fallback 度量覆盖（未实现，收益真实）

`font-display: optional` 在慢网络的首次访问还是会短暂显示系统字体再切换，切换时可能造成轻微布局跳动（CLS）。
给 fallback 字体声明 `@font-face { size-adjust / ascent-override / descent-override; ... }` 把它的度量压缩到接近真字体，能把 CLS 压到几乎为零。

实现要点：build 时读真字体的 `head` / `hhea` / `OS/2` 表拿到 unitsPerEm、ascent、descent，算出百分比 override，emit 一份 `Huiwen Mincho Fallback` 之类的 @font-face，然后 tokens.css 的 fallback 链在 `'Huiwen Mincho'` 和系统字体之间插入这个名字。约 30 行 Python + 几行 CSS 改动。

### 构建速度优化（页面多时才需要）

当前 `cmd_pages` 对每个 (page × face) 做一次 subset，字体已 load 一次；页面少时可忽略。上到 100+ 页且 build 变慢时，用 `multiprocessing.Pool` 按 face 分进程并行，能砍一半以上时间。不急。

---

## 设计决策与取舍

| 决策 | 为什么 |
|---|---|
| **L4 per-page subset** 而非 L3 unicode-range 切片 | 中文文本不像拉丁文那样聚集在某段 Unicode 范围，典型段落覆盖 CJK Unified 全部五大块。L3 单页仍下载 ~15 MB，L4 降到 ~50 KB。 |
| **Common pool + per-page extras**（≥2 页共用字符进 common） | 跨页导航时 common 已缓存，只补 extras；全站只下载一次共享核心。 |
| **`font-display: optional`** 不用 `swap` | `swap` 会有明显跳变（FOUT）。`optional` 如果字体到得慢就这次用系统字体，后台继续下载缓存给下次 → 视觉更克制。 |
| **激进丢表**：hinting、GPOS/GSUB、MATH、kern… 全砍 | 中文网页不用这些 OpenType 特性；这些表占文件体积小但每片都扛，砍掉能省 10-30%。视觉无差。 |
| **WOFF2 only**（不做 WOFF1 fallback） | 98%+ 现代浏览器支持；留 WOFF1 等于给 IE / 老 Safari 保留一套大文件，不划算。 |
| **preload 本页 + prefetch 链接页** | preload 是"这一页要用"，高优先；prefetch 是"下一页可能用"，浏览器空闲时拉。两种 hint 语义清晰。 |
| **Active face 从 tokens.css 扫描**（不手动声明） | 避免"tokens.css 改了但 build 脚本忘同步"的状态；只要样式里引用了，build 就处理它。 |
| **Dev/Prod 分两路**（不共用 per-page 产物） | 在 dev HMR 循环里跑 Python 太重；dev 用单文件 WOFF2 简单省事，prod 才做优化。 |

---

## 实测数字（2026-04-19，站内 3 页）

```
scanning 3 HTML file(s) under dist/
  404.html: 51 chars
  index.html: 50 chars
  sketches/hello-world/index.html: 94 chars
common pool: 51 chars
  common mincho       51 glyphs    17.9 KB
  common fangsong     51 glyphs    10.8 KB
  injected into 404.html (4 faces, 4 preload)
  injected into index.html (4 faces, 4 preload)
  injected into sketches/hello-world/index.html (4 faces, 4 preload)
per-page total across all pages: 77.6 KB
  prefetch from 404.html: 1 page(s), 2 hint(s)
  prefetch from index.html: 1 page(s), 2 hint(s)
  prefetch from sketches/hello-world/index.html: 1 page(s), 2 hint(s)
3 page(s) built in 3.44s
```

- 总部署字体体积：**~105 KB**（common 28 KB + 3 页 extras 77 KB）
- 单页首次打开拉的字体字节：**~40–100 KB**
- 跨页导航：只多拉 ~20 KB（common 已缓存）
- Build 时间：**3.44s**（Astro 1s + Python 2.4s）
- 对比基线（单文件 WOFF2）：**~300x 缩减**

---

## 约束与陷阱

- **Python 是 build-time 依赖**。CI 上部署要 `pip install fonttools brotli`。GitHub Actions 的 `actions/setup-python` 可以搞定。
- **canvas `fillText`** 只能用本页 subset 覆盖到的字形。动态中文必须声明 `data-font-pool`，否则 fallback 到系统字体。
- **`<a href>` 前缀必须 slash-absolute**（`/sketches/hello-world/`）prefetch hint 才识别；相对路径（`../`）不会被当作同站链接匹配。Astro 默认就是绝对路径，一般不成问题。
- **Dormant face 的 TTF 留在 `src/assets/fonts/` 是有意的**——TTF 是源材料，不参与 build，也不部署。保留是为了将来重新激活方便，不是 build 死代码。
- **修改 `tokens.css` 后不重跑 `build-fonts.py dev`**：dev 模式会继续用旧 `fonts-dev.css`，缺字或带多余 face。不致命但会困惑。

---

## 字体授权

当前 4 款汇文字体 (Mincho / Kaiti / Fangsong / HKHei) 嵌入的授权声明一致：

> 本字体文件开源且免费商用，禁止第三方在任何平台以任何方式用此字体牟利。
> 作者：TerryWang，2022；版本 v1.001。

个人博客自托管 = 用字体排版自己的内容，不是"拿字体牟利"。正常使用范围。
可用 [scripts/read-font-license.mjs](../scripts/read-font-license.mjs) 直接读 TTF 的 `name` 表验证原始声明。
