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

// hypothes.is custom event
interface ScrollToRange extends Event {
    detail?: Range;
}

const EPUB_CONTENT_STYLE = `
html,
body {
    margin: 0 !important;
    padding: 0 !important;
    color-scheme: light;
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
    initialRenderPending = false;
    initialRenderSettled = false;
    readonly readingModes = {
        scroll: { manager: 'continuous', flow: 'scrolled-doc', spread: 'none', minSpreadWidth: 0 },
        pagination: { manager: 'default', flow: 'paginated', spread: 'auto', minSpreadWidth: 1400, gap: 56 }
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

        this.configureNavigationEvents(book, id, this.settings.readingMode);
        this.addBookMetaToUI(book, iframe);
        book.rendition.on('rendered', (section: SpineItem, view?: { document?: Document; contents?: epubjs.Contents }) =>
            this.renderedHook(book, id, section, view)
        );

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

    addBookMetaToUI(book: epubjs.Book, iframe: HTMLIFrameElement) {
        // add chapters to table of contents
        book.loaded.navigation
            .then((nav: Navigation): void => {
                const toc = iframe.contentDocument.getElementById('toc'),
                    docfrag = iframe.contentDocument.createDocumentFragment();

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                nav.forEach((chapter: epubjs.NavItem): any => {
                    const item = iframe.contentDocument.createElement('li');
                    const link = iframe.contentDocument.createElement('a');

                    link.id = 'chap-' + chapter.id;
                    link.textContent = chapter.label;
                    link.href = chapter.href;
                    item.appendChild(link);
                    docfrag.appendChild(item);

                    link.onclick = () => {
                        const url = link.getAttribute('href');
                        book.rendition.display(url);
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
            iframe.contentDocument.getElementById('title').textContent = meta.title;
            iframe.contentDocument.getElementById('author').textContent = meta.creator;
        });

        // add cover to table of contents
        book.loaded.cover.then((cover: string) => {
            const coverImgEl = iframe.contentDocument.getElementById('cover') as HTMLImageElement;
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
                    book.rendition.display(cfi);
                }
                e.preventDefault();
            });
        });
    }

    configureNavigationEvents(book: epubjs.Book, id: Document, readingMode: 'scroll' | 'pagination') {
        // configure UI arrows
        if (readingMode == 'scroll') {
            id.querySelectorAll('a.arrow').forEach((e: HTMLElement) => (e.style.display = 'none'));
            id.querySelector('#viewer').classList.add('hide-after');
        }

        id.getElementById('next').addEventListener(
            'click',
            function (e: Event) {
                book.rendition.next();
                e.preventDefault();
            },
            false
        );

        id.getElementById('prev').addEventListener(
            'click',
            function (e: Event) {
                book.rendition.prev();
                e.preventDefault();
            },
            false
        );

        // turn pages by arrow buttons
        const keyListener = function (e: KeyboardEvent) {
            // Left Key
            if ((e.keyCode || e.which) == 37) {
                book.rendition.prev();
            }

            // Right Key
            if ((e.keyCode || e.which) == 39) {
                book.rendition.next();
            }
        };

        book.rendition.on('keyup', keyListener);
        id.addEventListener('keyup', keyListener, false);
        // to make keys work even when focus outside of reader iframe
        document.addEventListener('keyup', keyListener, false);

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
                const pendingImages = Array.from(contentDocument.images).filter(image => !image.complete);
                const pendingAssets: Promise<void>[] = pendingImages.map(
                    image =>
                        new Promise(resolve => {
                            image.addEventListener('load', () => resolve(), { once: true });
                            image.addEventListener('error', () => resolve(), { once: true });
                        })
                );

                if (contentDocument.fonts && contentDocument.fonts.status != 'loaded') {
                    pendingAssets.push(contentDocument.fonts.ready.then(() => undefined).catch(() => undefined));
                }

                if (pendingAssets.length > 0) {
                    await Promise.all(pendingAssets);
                }
            }
        } finally {
            this.initialRenderPending = false;
        }

        this.initialRenderSettled = true;
        requestAnimationFrame(() => {
            this.scheduleRelayout(book);
            requestAnimationFrame(() => this.removeLoader(id));
        });
    }
}
