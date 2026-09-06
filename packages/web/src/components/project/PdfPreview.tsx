'use client';

import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
import { fetchProjectFileContent, type ProjectFileInfo } from '@/lib/workspace-api';

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const PREVIEW_LIMIT_MIB = 32;
const MAX_PREVIEW_BYTES = PREVIEW_LIMIT_MIB * BYTES_PER_MIB;
const MAX_RENDER_MIB = 16;
const MAX_RENDER_PIXELS = MAX_RENDER_MIB * BYTES_PER_MIB;
const CANVAS_PADDING = 16;
const MAX_SCALE = 2;
const MAX_DEVICE_PIXEL_RATIO = 2;

interface PdfPreviewProps {
  projectId: string;
  sourceId: string;
  info: ProjectFileInfo;
}

interface PdfInput {
  projectId: string;
  sourceId: string;
  info: ProjectFileInfo;
}

function abortError(): DOMException {
  return new DOMException('The PDF preview was cancelled.', 'AbortError');
}

function previewLimitMessage(): string {
  return `PDF preview is limited to ${PREVIEW_LIMIT_MIB} MiB. Download the file to view it.`;
}

function disposePdf(loadingTask: PDFDocumentLoadingTask | undefined): void {
  if (loadingTask) void loadingTask.destroy().catch(() => undefined);
}

async function readPdfBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_BYTES) {
    throw new Error(previewLimitMessage());
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PREVIEW_BYTES) {
      throw new Error(previewLimitMessage());
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PREVIEW_BYTES) {
        await reader.cancel('PDF preview size limit exceeded');
        throw new Error(previewLimitMessage());
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function loadPdf(
  input: PdfInput,
  signal: AbortSignal,
  onLoadingTask: (task: PDFDocumentLoadingTask) => void,
): Promise<PDFDocumentProxy> {
  const response = await fetchProjectFileContent(input.projectId, {
    sourceId: input.sourceId,
    path: input.info.path,
    revision: input.info.revision,
    signal,
  });
  const bytes = await readPdfBytes(response, signal);
  if (signal.aborted) throw abortError();
  const pdfjs = await import('pdfjs-dist');
  if (signal.aborted) throw abortError();
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const task = pdfjs.getDocument({ data: bytes, enableXfa: false, stopAtErrors: true });
  onLoadingTask(task);
  return task.promise;
}

function usePdfDocument(input: PdfInput) {
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    let loadingTask: PDFDocumentLoadingTask | undefined;
    setDocument(undefined);
    setPageCount(0);
    setError(undefined);
    setLoading(false);
    if (input.info.size > MAX_PREVIEW_BYTES) {
      setError(previewLimitMessage());
      return () => controller.abort();
    }

    setLoading(true);
    void loadPdf(input, controller.signal, (task) => {
      loadingTask = task;
    })
      .then((nextDocument) => {
        if (controller.signal.aborted) return;
        setDocument(nextDocument);
        setPageCount(nextDocument.numPages);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Could not load this PDF.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
      disposePdf(loadingTask);
    };
  }, [input.info.path, input.info.revision, input.info.size, input.projectId, input.sourceId]);

  return { document, pageCount, loading, error };
}

function renderScale(page: PDFPageProxy, width: number): number {
  const baseViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(1, width - CANVAS_PADDING);
  const widthScale = baseViewport.width > 0 ? availableWidth / baseViewport.width : 1;
  let scale = Math.min(MAX_SCALE, Math.max(Number.EPSILON, widthScale));
  const pixels =
    baseViewport.width * baseViewport.height * scale * scale * MAX_DEVICE_PIXEL_RATIO ** 2;
  if (pixels > MAX_RENDER_PIXELS) scale *= Math.sqrt(MAX_RENDER_PIXELS / pixels);
  return scale;
}

function textFromContent(content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>): string {
  return content.items
    .map((item) => ('str' in item ? item.str : ''))
    .filter(Boolean)
    .join(' ');
}

interface RenderInput {
  document: PDFDocumentProxy;
  pageNumber: number;
  canvas: HTMLCanvasElement;
  width: number;
  signal: AbortSignal;
  onRenderTask: (task: RenderTask) => void;
}

async function renderPdfPage(input: RenderInput): Promise<string> {
  const page = await input.document.getPage(input.pageNumber);
  if (input.signal.aborted) throw abortError();
  const scale = renderScale(page, input.width);
  const viewport = page.getViewport({ scale });
  const outputScale = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
  const context = input.canvas.getContext('2d');
  if (!context) throw new Error('PDF preview canvas is unavailable.');
  input.canvas.width = Math.ceil(viewport.width * outputScale);
  input.canvas.height = Math.ceil(viewport.height * outputScale);
  input.canvas.style.width = `${Math.ceil(viewport.width)}px`;
  input.canvas.style.height = `${Math.ceil(viewport.height)}px`;
  const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
  const renderTask = page.render({
    canvasContext: context,
    canvas: input.canvas,
    viewport,
    transform,
  });
  input.onRenderTask(renderTask);
  await renderTask.promise;
  if (input.signal.aborted) throw abortError();
  return textFromContent(await page.getTextContent());
}

interface PdfPageInput {
  document: PDFDocumentProxy | undefined;
  pageNumber: number;
  width: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

interface PdfRenderScheduleInput {
  previous: Promise<void>;
  document: PDFDocumentProxy;
  pageNumber: number;
  canvas: HTMLCanvasElement;
  width: number;
  signal: AbortSignal;
  isActive: () => boolean;
  onRenderTask: (task: RenderTask) => void;
}

function schedulePdfRender(input: PdfRenderScheduleInput): Promise<string> {
  return input.previous
    .catch(() => undefined)
    .then(() => {
      if (!input.isActive() || input.signal.aborted) throw abortError();
      return renderPdfPage({
        document: input.document,
        pageNumber: input.pageNumber,
        canvas: input.canvas,
        width: input.width,
        signal: input.signal,
        onRenderTask: input.onRenderTask,
      });
    });
}

interface PdfPageEffectInput {
  input: PdfPageInput;
  renderChain: MutableRefObject<Promise<void>>;
  setText: (value: string) => void;
  setError: (value: string | undefined) => void;
  setRendered: (value: boolean) => void;
}

function startPdfPageRender(effect: PdfPageEffectInput): (() => void) | undefined {
  const canvas = effect.input.canvasRef.current;
  const document = effect.input.document;
  if (!document || !canvas || effect.input.width <= 0) {
    effect.setText('');
    effect.setRendered(false);
    return undefined;
  }
  const controller = new AbortController();
  let renderTask: RenderTask | undefined;
  let active = true;
  effect.setText('');
  effect.setError(undefined);
  effect.setRendered(false);
  const run = schedulePdfRender({
    previous: effect.renderChain.current,
    document,
    pageNumber: effect.input.pageNumber,
    canvas,
    width: effect.input.width,
    signal: controller.signal,
    isActive: () => active,
    onRenderTask: (task) => {
      renderTask = task;
      if (!active) task.cancel();
    },
  });
  effect.renderChain.current = run.then(
    () => undefined,
    () => undefined,
  );
  void run
    .then((nextText) => {
      if (active) {
        effect.setText(nextText);
        effect.setRendered(true);
      }
    })
    .catch((cause: unknown) => {
      if (active && cause instanceof Error && cause.name !== 'RenderingCancelledException') {
        effect.setError(cause.message);
      }
    });
  return () => {
    active = false;
    controller.abort();
    renderTask?.cancel();
  };
}

function usePdfPage(input: PdfPageInput) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [rendered, setRendered] = useState(false);
  const renderChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(
    () => startPdfPageRender({ input, renderChain, setText, setError, setRendered }),
    [input.canvasRef, input.document, input.pageNumber, input.width],
  );

  return { text, error, rendered };
}

function PdfControls({
  pageNumber,
  pageCount,
  onPageChange,
}: {
  pageNumber: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <nav aria-label="PDF page controls" className="flex items-center justify-center gap-3 text-xs">
      <button
        type="button"
        aria-label="Previous PDF page"
        disabled={pageNumber <= 1}
        onClick={() => onPageChange(pageNumber - 1)}
        className="rounded border px-2 py-1 disabled:opacity-50"
      >
        Previous
      </button>
      <span role="status">
        Page {pageNumber} of {pageCount}
      </span>
      <button
        type="button"
        aria-label="Next PDF page"
        disabled={pageNumber >= pageCount}
        onClick={() => onPageChange(pageNumber + 1)}
        className="rounded border px-2 py-1 disabled:opacity-50"
      >
        Next
      </button>
    </nav>
  );
}

function PreviewMessage({ message, muted = false }: { message: string; muted?: boolean }) {
  return (
    <p
      role={muted ? undefined : 'alert'}
      className="text-sm"
      style={{ color: muted ? 'var(--text-muted)' : 'var(--error)' }}
    >
      {message}
    </p>
  );
}

function useContainerWidth(containerRef: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resize = () => setWidth(container.clientWidth);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);
  return width;
}

interface ResetPdfPageInput {
  info: ProjectFileInfo;
  projectId: string;
  sourceId: string;
  setPageNumber: (page: number) => void;
}

function useResetPdfPage(input: ResetPdfPageInput): void {
  useEffect(() => {
    input.setPageNumber(1);
  }, [input.info.path, input.info.revision, input.projectId, input.setPageNumber, input.sourceId]);
}

function useClampPdfPage(
  pageCount: number,
  pageNumber: number,
  setPageNumber: (page: number) => void,
): void {
  useEffect(() => {
    if (pageCount > 0 && pageNumber > pageCount) setPageNumber(pageCount);
  }, [pageCount, pageNumber, setPageNumber]);
}

interface PdfCanvasPanelProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  page: { text: string; rendered: boolean };
  pageCount: number;
  pageNumber: number;
  onPageChange: (page: number) => void;
}

function PdfCanvasPanel(input: PdfCanvasPanelProps) {
  return (
    <>
      <PdfControls
        pageNumber={input.pageNumber}
        pageCount={input.pageCount}
        onPageChange={input.onPageChange}
      />
      <div className="max-h-[55vh] overflow-auto rounded border bg-white p-2">
        <canvas
          ref={input.canvasRef}
          role="img"
          aria-label={`PDF page ${input.pageNumber}`}
          data-rendered={input.page.rendered ? 'true' : 'false'}
          className="mx-auto block"
        />
      </div>
      {input.page.text && (
        <details>
          <summary className="cursor-pointer text-xs">Page text</summary>
          <p className="whitespace-pre-wrap text-xs" aria-label="Extracted PDF text">
            {input.page.text}
          </p>
        </details>
      )}
    </>
  );
}

export function PdfPreview({ projectId, sourceId, info }: PdfPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const width = useContainerWidth(containerRef);
  const pdf = usePdfDocument({
    projectId,
    sourceId,
    info,
  });
  const page = usePdfPage({ document: pdf.document, pageNumber, width, canvasRef });
  useResetPdfPage({ info, projectId, sourceId, setPageNumber });
  useClampPdfPage(pdf.pageCount, pageNumber, setPageNumber);

  const error = pdf.error ?? page.error;
  return (
    <div ref={containerRef} className="space-y-2">
      {error && <PreviewMessage message={error} />}
      {pdf.loading && <PreviewMessage message="Loading PDF preview…" muted />}
      {!pdf.loading && !pdf.error && pdf.pageCount === 0 && (
        <PreviewMessage message="PDF has no pages." muted />
      )}
      {pdf.pageCount > 0 && (
        <PdfCanvasPanel
          canvasRef={canvasRef}
          page={page}
          pageCount={pdf.pageCount}
          pageNumber={pageNumber}
          onPageChange={setPageNumber}
        />
      )}
    </div>
  );
}
