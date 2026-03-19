# EPUB Reader 渲染与翻页代码定位

## 1. 主调用链

1. 插件注册 `EpubAnnotation` 组件  
   文件: `src/main.tsx`  
   关键位置: `this.EpubAnnotation = defineEpubAnnotation(this.app.vault, this);`

2. 视图层根据 `annotation-target-type=epub` 渲染 EPUB 组件  
   文件: `src/annotatorView.tsx`  
   关键位置: `case 'epub'` 分支中渲染 `<this.plugin.EpubAnnotation ... />`

3. EPUB 组件加载内置 reader 页面并启动 `EpubReader`  
   文件: `src/defineEpubAnnotation.tsx`  
   关键位置: `baseSrc="https://cdn.hypothes.is/demos/epub/epub.js/index.html"`  
   在 `onload` 内创建 `new EpubReader(plugin.settings.epubSettings)` 并执行 `start(iframe)`


## 2. 渲染核心（epub.js）

文件: `src/defineEpubAnnotation.tsx`

- `initBook(...)` 里创建 `new epubjs.Book(...)`，并通过 `book.renderTo(id.getElementById('viewer'), ...)` 渲染到 reader 页面里的 `#viewer`。
- 阅读模式由设置决定:
  - `scroll`: `{ manager: 'continuous', flow: 'scrolled' }`
  - `pagination`: `{ manager: 'default', flow: 'paginated' }`
- 初始展示调用: `book.rendition.display()`
- 渲染事件:
  - `book.rendition.on('rendered', ...)` 更新标题、目录高亮、历史 `?loc=...`
  - `book.rendition.on('relocated', ...)` 重新应用字号


## 3. 翻页逻辑（你要找的核心）

文件: `src/defineEpubAnnotation.tsx` 的 `configureNavigationEvents(...)`

- UI 按钮翻页:
  - `#next` 点击 -> `book.rendition.next()`
  - `#prev` 点击 -> `book.rendition.prev()`
- 键盘翻页:
  - 左方向键(37) -> `book.rendition.prev()`
  - 右方向键(39) -> `book.rendition.next()`
  - 监听绑定在:
    - `book.rendition.on('keyup', keyListener)`
    - reader 文档 `id.addEventListener('keyup', keyListener, false)`
    - 顶层 `document.addEventListener('keyup', keyListener, false)`（用于焦点不在 iframe 时）
- `scroll` 模式下:
  - 隐藏所有 `a.arrow`（即左右翻页按钮）
  - 给 `#viewer` 添加 `hide-after`，隐藏分页中线


## 4. 其他会触发“定位/翻页式跳转”的入口

### 4.1 目录跳转（TOC）

文件: `src/defineEpubAnnotation.tsx` 的 `addBookMetaToUI(...)`

- 动态生成目录 `#toc`
- 目录项点击后执行 `book.rendition.display(url)`

### 4.2 Hypothesis 选区跳转

文件: `src/defineEpubAnnotation.tsx`

- 在 `book.rendition.hooks.content.register(...)` 中监听 `scrolltorange`
- 将 range 转成 CFI 后执行 `book.rendition.display(cfi)`

### 4.3 从注释定位回 EPUB

文件: `src/annotatorView.tsx` 的 `scrollToAnnotation(...)`

- 对 `epub` 类型: 从 `annotation.uri` 读取 `loc`
- 调用 `(this.iframe.contentWindow as any).rendition.display(loc)` 跳转到对应位置


## 5. Reader 模板与样式位置

1. HTML 模板  
   文件: `resources/cdn.hypothes.is/demos/epub/epub.js/index.html`  
   关键节点:
   - `#viewer` 渲染容器
   - `#prev` / `#next` 翻页按钮
   - `#navigation` 目录面板

2. 样式  
   文件: `resources/cdn.hypothes.is/demos/epub/epub.js/css/reader.css`  
   关键样式:
   - `.arrow`、`#prev`、`#next` 按钮样式
   - `#viewer.spreads:after` 分页中线
   - `.hide-after:after { display: none; }`（滚动模式隐藏中线）


## 6. EPUB 文件替换链（数据是怎么接入 reader 的）

文件: `src/defineGenericAnnotation.tsx`

- `OfflineIframe` 加载 `baseSrc`（epub reader 页面）
- `htmlPostProcessFunction` 将模板内的 `SAMPLE_EPUB_URL` 替换为真实 `props.epub` 对应 URL
- `proxy(...)` 中 `SAMPLE_EPUB_URL` / `props.epub` 会映射到真实资源（`vault:/...` 或标准 URL）


## 7. 设置入口

文件: `src/settings.tsx`

- `epubSettings.readingMode`: `scroll` / `pagination`
- `epubSettings.fontSize`: 字号百分比
- 默认值:
  - `readingMode: 'pagination'`
  - `fontSize: 100`
