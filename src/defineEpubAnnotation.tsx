import * as genericAnnotation from 'defineGenericAnnotation';
import React from 'react';
import { Vault } from 'obsidian';
import AnnotatorPlugin from 'main';

import { AnnotatorSettings } from 'settings';
import { EpubAnnotationProps } from './types';

import * as epubjs from 'epubjs';
import { SpineItem } from 'epubjs/types/section';
import { PackagingMetadataObject } from 'epubjs/types/packaging';
import Navigation from 'epubjs/types/navigation';

import { wait } from 'utils';
import { SAMPLE_EPUB_URL } from './constants';

export default (vault: Vault, plugin: AnnotatorPlugin) => {
    const GenericAnnotationEpub = genericAnnotation.default(vault, plugin);
    const EpubAnnotation = ({ ...props }: EpubAnnotationProps) => {
        return (
            <GenericAnnotationEpub
                baseSrc="https://cdn.hypothes.is/demos/epub/epub.js/index.html"
                {...props}
                onload={async iframe => {
                    await props.onload?.(iframe);
                    while (iframe?.contentDocument?.body?.innerHTML == '') {
                        await wait(50);
                    }
                    if (iframe.dataset.annotatorEpubReaderStarted == 'true') {
                        return;
                    }
                    iframe.dataset.annotatorEpubReaderStarted = 'true';

                    const epubReader = new EpubReader(plugin.settings.epubSettings);
                    void epubReader.start(iframe);
                }}
            />
        );
    };
    return EpubAnnotation;
};

interface readerWindow extends Window {
    rendition?: epubjs.Rendition;
}

type HypothesisSidebarLayoutState = {
    expanded?: boolean;
    width?: number;
    toolbarWidth?: number;
};

type RenditionManager = {
    isPaginated?: boolean;
    container?: HTMLElement;
    layout?: {
        delta?: number;
        divisor?: number;
    };
    settings?: {
        axis?: 'horizontal' | 'vertical';
        direction?: 'ltr' | 'rtl';
        rtlScrollType?: 'default' | string;
    };
    views?: {
        length?: number;
        displayed?: () => Array<{
            document?: Document;
            contents?: { document?: Document };
        }>;
    };
};

// hypothes.is custom event
interface ScrollToRange extends Event {
    detail?: Range;
}

const EPUB_CONTENT_STYLE = `
html,
body {
    margin: 0 !important;
    padding: 0 !important;
    overflow-wrap: break-word;
    word-break: normal;
}

body {
    line-height: 1.65;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
}

p,
li,
blockquote,
dd {
    line-height: 1.65;
}

img,
svg,
video,
canvas {
    display: block;
    max-width: 100% !important;
    height: auto !important;
    margin-left: auto;
    margin-right: auto;
    break-inside: avoid;
    page-break-inside: avoid;
}

figure,
table,
pre,
blockquote {
    max-width: 100% !important;
    break-inside: avoid;
    page-break-inside: avoid;
}

pre {
    white-space: pre-wrap !important;
}

table {
    width: 100%;
    border-collapse: collapse;
}
`;

class EpubReader {
    readonly bookUrl: string;
    readonly settings: AnnotatorSettings['epubSettings'];
    readonly viewerAspectRatio = 16 / 10;
    readonly paginationMinSpreadWidth = 1280;
    initialRenderPending = false;
    initialRenderSettled = false;
    activeNavigationId = 0;
    readonly readingModes = {
        scroll: { manager: 'continuous', flow: 'scrolled-doc', spread: 'none', minSpreadWidth: 0 },
        pagination: { manager: 'default', flow: 'paginated', spread: 'auto', minSpreadWidth: 1280, gap: 56 }
    };
    relayoutTimer: number | null = null;

    constructor(epubSettings: AnnotatorSettings['epubSettings']) {
        this.bookUrl = SAMPLE_EPUB_URL;
        this.settings = epubSettings;
    }

    async start(iframe: HTMLIFrameElement): Promise<void> {
        const id = iframe.contentDocument;

        // linter says it's possible that iframe would be null
        // should be fixed in a future
        const iw: readerWindow | null = iframe.contentWindow;

        const book = this.initBook(id, iw);
        this.bindLayoutObservers(book, id, iw, iframe);

        this.syncSpreadMode(book, id);
        this.updateViewerLayoutState(book, id);
        this.configureNavigationEvents(book, id, this.settings.readingMode);
        this.addBookMetaToUI(book, id);
        book.rendition.on('rendered', (section: SpineItem, view?: { document?: Document; contents?: epubjs.Contents }) =>
            this.renderedHook(book, id, section, view)
        );
        book.rendition.on('resized', () => {
            this.updateViewerLayoutState(book, id);
        });

        await book.rendition.display();
        void book.ready.then(async () => {
            await wait(2000);
            if (!this.initialRenderSettled) {
                this.removeLoader(id);
            }
        });
    }

    initBook(id: Document, iw: readerWindow): epubjs.Book {
        const book = new epubjs.Book(this.bookUrl, {
            requestMethod: async function (url) {
                return await (await iw.fetch(url)).arrayBuffer();
            },
            canonical: function (path) {
                return iw.location.origin + iw.location.pathname + '?loc=' + path;
            }
        });

        book.renderTo(id.getElementById('viewer'), {
            ...this.readingModes[this.settings.readingMode],
            ignoreClass: 'annotator-hl',
            width: '100%',
            height: '100%',
            allowScriptedContent: true
        });

        book.rendition.themes.fontSize(`${this.settings.fontSize}%`);

        iw.rendition = book.rendition;
        return book;
    }

    renderedHook(book: epubjs.Book, id: Document, section: SpineItem, view?: { document?: Document; contents?: epubjs.Contents }) {
        this.syncSpreadMode(book, id);
        this.updateViewerLayoutState(book, id);
        const current = book.navigation && book.navigation.get(section.href);

        if (current) {
            id.title = current.label;

            // TODO: this is needed to trigger the hypothesis client
            // to inject into the iframe
            requestAnimationFrame(function () {
                id.getElementById('hiddenTitle').textContent = section.href;
            });

            // Add CFI fragment to the history
            history.pushState({}, '', '?loc=' + encodeURIComponent(section.href));

            id.querySelectorAll('.active').forEach(function (link) {
                link.classList.remove('active');
            });

            const active = id.querySelector('a[href="' + section.href + '"]');
            if (active) {
                active.classList.add('active');
            }
        }

        if (!this.initialRenderPending && !this.initialRenderSettled) {
            this.initialRenderPending = true;
            void this.finishInitialRender(book, id, view?.document ?? view?.contents?.document);
        }
    }

    addBookMetaToUI(book: epubjs.Book, id: Document) {
        // add chapters to table of contents
        book.loaded.navigation
            .then((nav: Navigation): void => {
                const toc = id.getElementById('toc'),
                    docfrag = id.createDocumentFragment();

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                nav.forEach((chapter: epubjs.NavItem): any => {
                    const item = id.createElement('li');
                    const link = id.createElement('a');

                    link.id = 'chap-' + chapter.id;
                    link.textContent = chapter.label;
                    link.href = chapter.href;
                    item.appendChild(link);
                    docfrag.appendChild(item);

                    link.onclick = () => {
                        const url = link.getAttribute('href');
                        void this.displaySection(book, id, url);
                        return false;
                    };
                });

                toc.appendChild(docfrag);
            })
            .catch(() => {
                throw 'Failed to load book navigation';
            });

        // add title and author to table of contents
        book.loaded.metadata.then(function (meta: PackagingMetadataObject) {
            id.getElementById('title').textContent = meta.title;
            id.getElementById('author').textContent = meta.creator;
        });

        // add cover to table of contents
        book.loaded.cover.then((cover: string) => {
            const coverImgEl = id.getElementById('cover') as HTMLImageElement;
            coverImgEl.alt = 'Book cover';

            if (!cover) {
                coverImgEl.hidden = true;
                return;
            }

            coverImgEl.hidden = false;
            if (book.archive) {
                book.archive
                    .createUrl(cover, { base64: false })
                    .then(url => {
                        coverImgEl.src = url;
                    })
                    .catch(() => {
                        coverImgEl.hidden = true;
                    });
            } else {
                coverImgEl.src = cover;
            }
        });

        book.rendition.hooks.content.register((contents: epubjs.Contents) => {
            const contentDocument = contents.document;
            if (!contentDocument) {
                return;
            }

            this.applyContentStyles(contentDocument);
            this.watchContentAssets(contentDocument, () => this.scheduleRelayout(book));
            if (contentDocument.fonts && contentDocument.fonts.status != 'loaded') {
                void contentDocument.fonts.ready
                    .then(() => this.scheduleRelayout(book))
                    .catch(() => undefined);
            }

            contents.window.addEventListener('scrolltorange', function (e: ScrollToRange) {
                if (e.detail === undefined) return;

                const range = e.detail.toString();
                const cfi = new epubjs.EpubCFI(range, contents.cfiBase).toString();

                if (cfi) {
                    void this.displaySection(book, id, cfi);
                }
                e.preventDefault();
            });
        });
    }

    configureNavigationEvents(book: epubjs.Book, id: Document, readingMode: 'scroll' | 'pagination') {
        // configure UI arrows
        if (readingMode == 'scroll') {
            id.querySelectorAll('.arrow').forEach((e: HTMLElement) => (e.style.display = 'none'));
            id.querySelector('#viewer').classList.add('hide-after');
        }

        id.getElementById('next').addEventListener(
            'click',
            (e: Event) => {
                void this.navigate(book, id, 'next');
                e.preventDefault();
            },
            false
        );

        id.getElementById('prev').addEventListener(
            'click',
            (e: Event) => {
                void this.navigate(book, id, 'prev');
                e.preventDefault();
            },
            false
        );

        // turn pages by arrow buttons
        const keyListener = (e: KeyboardEvent) => {
            // Left Key
            if ((e.keyCode || e.which) == 37) {
                void this.navigate(book, id, 'prev');
            }

            // Right Key
            if ((e.keyCode || e.which) == 39) {
                void this.navigate(book, id, 'next');
            }
        };

        book.rendition.on('keyup', keyListener);
        id.addEventListener('keyup', keyListener, false);

        // open/close table of contents
        const nav = id.getElementById('navigation');

        id.getElementById('opener').addEventListener(
            'click',
            function () {
                nav.classList.add('open');
            },
            false
        );

        id.getElementById('closer').addEventListener(
            'click',
            function () {
                nav.classList.remove('open');
            },
            false
        );
    }

    removeLoader = (id: Document) => {
        id.getElementById('viewer').classList.remove('loading');
    };

    bindLayoutObservers(book: epubjs.Book, id: Document, iw: readerWindow, iframe: HTMLIFrameElement) {
        const relayout = () => {
            void this.waitForAnimationFrames(2).then(() => {
                this.syncSpreadMode(book, id);
                this.scheduleRelayout(book);
                requestAnimationFrame(() => this.updateViewerLayoutState(book, id));
            });
        };

        const viewer = id.getElementById('viewer');
        iw.addEventListener('resize', relayout);
        iw.addEventListener('annotator-sidebar-layoutchange', (_event: Event) => {
            const sidebarEvent = _event as CustomEvent<HypothesisSidebarLayoutState>;
            if (!sidebarEvent.detail?.expanded) {
                relayout();
                return;
            }

            relayout();
        });
        let lastViewerWidth = Math.round(viewer?.getBoundingClientRect().width || 0);
        let lastViewerHeight = Math.round(viewer?.getBoundingClientRect().height || 0);
        let lastIframeWidth = iframe.clientWidth;
        let lastIframeHeight = iframe.clientHeight;

        const intervalId = iw.setInterval(() => {
            const nextViewerWidth = Math.round(viewer?.getBoundingClientRect().width || 0);
            const nextViewerHeight = Math.round(viewer?.getBoundingClientRect().height || 0);
            const nextIframeWidth = iframe.clientWidth;
            const nextIframeHeight = iframe.clientHeight;

            if (
                nextViewerWidth == lastViewerWidth &&
                nextViewerHeight == lastViewerHeight &&
                nextIframeWidth == lastIframeWidth &&
                nextIframeHeight == lastIframeHeight
            ) {
                return;
            }

            lastViewerWidth = nextViewerWidth;
            lastViewerHeight = nextViewerHeight;
            lastIframeWidth = nextIframeWidth;
            lastIframeHeight = nextIframeHeight;
            relayout();
        }, 150);

        const disconnectObservers = () => {
            iw.clearInterval(intervalId);
        };

        iw.addEventListener('unload', disconnectObservers, { once: true });
    }

    setViewerPreparing(id: Document, preparing: boolean) {
        id.getElementById('viewer')?.classList.toggle('preparing', preparing);
    }

    syncSpreadMode(book: epubjs.Book, id: Document) {
        if (this.settings.readingMode != 'pagination') {
            return;
        }

        const viewerWidth = this.getPaginationViewerMetrics(id)?.layoutWidth || 0;
        const spreadMode = viewerWidth >= this.paginationMinSpreadWidth ? 'auto' : 'none';
        const rendition = book.rendition as epubjs.Rendition & { spread?: (spread: string, min?: number) => void };

        rendition.spread?.(spreadMode, this.paginationMinSpreadWidth);
    }

    updateViewerLayoutState(book: epubjs.Book, id: Document) {
        this.syncPaginationViewerScale(id);
        const manager = this.getManager(book);
        const viewer = id.getElementById('viewer') as HTMLElement | null;
        const isTwoUp = this.settings.readingMode == 'pagination' && manager?.layout?.divisor == 2;

        viewer?.classList.toggle('is-two-up', isTwoUp);
    }

    syncPaginationViewerScale(id: Document) {
        const stage = id.getElementById('reader-stage') as HTMLElement | null;
        const viewer = id.getElementById('viewer') as HTMLElement | null;
        const isPagination = this.settings.readingMode == 'pagination';

        stage?.classList.toggle('is-pagination-mode', isPagination);
        viewer?.classList.toggle('is-pagination-mode', isPagination);

        if (!stage || !viewer) {
            return;
        }

        if (!isPagination) {
            stage.style.width = '';
            viewer.style.width = '';
            viewer.style.height = '';
            viewer.style.transform = '';
            return;
        }

        const metrics = this.getPaginationViewerMetrics(id);
        if (!metrics) {
            return;
        }

        const { layoutWidth, visibleWidth, scale } = metrics;
        stage.style.width = `${visibleWidth}px`;
        viewer.style.width = `${layoutWidth}px`;
        viewer.style.height = `${layoutWidth / this.viewerAspectRatio}px`;
        viewer.style.transform = `translateX(-50%) scale(${scale})`;
    }

    getPaginationViewerMetrics(id: Document) {
        if (this.settings.readingMode != 'pagination') {
            return null;
        }

        const iw = id.defaultView;
        if (!iw) {
            return null;
        }

        const rootStyles = iw.getComputedStyle(id.documentElement);
        const gutterX = this.readCssPx(rootStyles.getPropertyValue('--reader-gutter-x'), 72);
        const gutterY = this.readCssPx(rootStyles.getPropertyValue('--reader-gutter-y'), 16);
        const bottomGutter = this.readCssPx(rootStyles.getPropertyValue('--reader-bottom-gutter'), 24);
        const sidebarWidth = this.readCssPx(rootStyles.getPropertyValue('--hypothesis-sidebar-width'), 0);
        const maxWidthByHeight = Math.max(0, (iw.innerHeight - gutterY - bottomGutter) * this.viewerAspectRatio);
        const layoutWidth = Math.max(0, Math.min(maxWidthByHeight, iw.innerWidth - gutterX * 2));
        const visibleWidth = Math.max(0, Math.min(maxWidthByHeight, iw.innerWidth - gutterX * 2 - sidebarWidth));
        const scale = layoutWidth > 0 ? Math.min(1, visibleWidth / layoutWidth) : 1;

        return {
            layoutWidth,
            visibleWidth,
            scale
        };
    }

    readCssPx(value: string, fallback: number) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    getManager(book: epubjs.Book): RenditionManager | undefined {
        return (book.rendition as epubjs.Rendition & { manager?: RenditionManager }).manager;
    }

    async displaySection(book: epubjs.Book, id: Document, target: string) {
        await this.runPrerenderedNavigation(book, id, () => book.rendition.display(target));
    }

    async navigate(book: epubjs.Book, id: Document, direction: 'next' | 'prev') {
        if (this.shouldPrerenderNavigation(book, direction)) {
            await this.runPrerenderedNavigation(book, id, () => book.rendition[direction]());
            return;
        }

        await book.rendition[direction]();
    }

    shouldPrerenderNavigation(book: epubjs.Book, direction: 'next' | 'prev') {
        if (this.settings.readingMode != 'pagination') {
            return false;
        }

        const manager = this.getManager(book);
        const container = manager?.container;
        const delta = manager?.layout?.delta;
        const axis = manager?.settings?.axis;
        const dir = manager?.settings?.direction;
        const rtlScrollType = manager?.settings?.rtlScrollType;

        if (!manager?.isPaginated || !container || !delta) {
            return true;
        }

        if (axis == 'vertical') {
            if (direction == 'next') {
                return container.scrollTop + container.offsetHeight >= container.scrollHeight;
            }

            return container.scrollTop <= 0;
        }

        if (dir == 'rtl') {
            if (rtlScrollType == 'default') {
                if (direction == 'next') {
                    return container.scrollLeft <= 0;
                }

                return container.scrollLeft + container.offsetWidth >= container.scrollWidth;
            }

            if (direction == 'next') {
                return container.scrollLeft + delta * -1 <= container.scrollWidth * -1;
            }

            return container.scrollLeft >= 0;
        }

        if (direction == 'next') {
            return container.scrollLeft + container.offsetWidth + delta > container.scrollWidth;
        }

        return container.scrollLeft <= 0;
    }

    async runPrerenderedNavigation(book: epubjs.Book, id: Document, action: () => Promise<void> | void) {
        const navigationId = ++this.activeNavigationId;
        this.setViewerPreparing(id, true);

        try {
            await action();
            await this.waitForDisplayedViews(book, 1200);
            this.scheduleRelayout(book);
            await this.waitForAnimationFrames(2);
            this.updateViewerLayoutState(book, id);
        } finally {
            if (navigationId == this.activeNavigationId) {
                this.setViewerPreparing(id, false);
                this.removeLoader(id);
            }
        }
    }

    async waitForDisplayedViews(book: epubjs.Book, maxWaitMs: number) {
        const manager = this.getManager(book);
        const displayedViews = manager?.views?.displayed?.() || [];
        const uniqueDocuments = [...new Set(displayedViews.map(view => view.document || view.contents?.document).filter(x => x))];

        if (uniqueDocuments.length == 0) {
            await this.waitForAnimationFrames(2);
            return;
        }

        await Promise.all(uniqueDocuments.map(doc => this.waitForDocumentToSettle(doc, maxWaitMs)));
    }

    async waitForDocumentToSettle(contentDocument: Document, maxWaitMs: number) {
        const pendingAssets: Promise<void>[] = Array.from(contentDocument.images)
            .filter(image => !image.complete)
            .map(
                image =>
                    new Promise(resolve => {
                        image.addEventListener('load', () => resolve(), { once: true });
                        image.addEventListener('error', () => resolve(), { once: true });
                    })
            );

        if (contentDocument.fonts && contentDocument.fonts.status != 'loaded') {
            pendingAssets.push(contentDocument.fonts.ready.then(() => undefined).catch(() => undefined));
        }

        if (pendingAssets.length == 0) {
            await this.waitForAnimationFrames(1);
            return;
        }

        await Promise.race([Promise.all(pendingAssets.map(asset => asset.catch(() => undefined))), wait(maxWaitMs)]);
    }

    waitForAnimationFrames(frameCount: number) {
        return new Promise<void>(resolve => {
            const step = (remainingFrames: number) => {
                if (remainingFrames <= 0) {
                    resolve();
                    return;
                }

                requestAnimationFrame(() => step(remainingFrames - 1));
            };

            step(frameCount);
        });
    }

    applyContentStyles(id: Document) {
        if (id.getElementById('annotator-epub-content-style')) {
            return;
        }

        const style = id.createElement('style');
        style.id = 'annotator-epub-content-style';
        style.textContent = EPUB_CONTENT_STYLE;
        (id.head || id.documentElement).appendChild(style);
    }

    watchContentAssets(id: Document, onAssetStateChanged: () => void) {
        const images = Array.from(id.images);
        images.forEach(image => {
            if (image.complete) {
                return;
            }

            image.addEventListener('load', onAssetStateChanged, { once: true });
            image.addEventListener('error', onAssetStateChanged, { once: true });
        });
    }

    scheduleRelayout(book: epubjs.Book) {
        if (this.relayoutTimer != null) {
            window.clearTimeout(this.relayoutTimer);
        }

        this.relayoutTimer = window.setTimeout(() => {
            this.relayoutTimer = null;
            (book.rendition as epubjs.Rendition & { resize?: () => void }).resize?.();
        }, 120);
    }

    async finishInitialRender(book: epubjs.Book, id: Document, contentDocument?: Document) {
        try {
            if (contentDocument) {
                await this.waitForDocumentToSettle(contentDocument, 1800);
            }
        } finally {
            this.initialRenderPending = false;
        }

        this.initialRenderSettled = true;
        requestAnimationFrame(() => {
            this.scheduleRelayout(book);
            requestAnimationFrame(() => {
                this.updateViewerLayoutState(book, id);
                this.removeLoader(id);
            });
        });
    }
}
