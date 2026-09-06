'use client';

import { useEffect, useState } from 'react';
import {
  fetchProjectFileContent,
  headProjectFileContent,
  projectFileContentUrl,
  type ProjectFileInfo,
} from '@/lib/workspace-api';
import { PdfPreview } from './PdfPreview';

interface FilePreviewProps {
  projectId: string;
  sourceId: string;
  info: ProjectFileInfo;
}

function downloadLink(projectId: string, sourceId: string, info: ProjectFileInfo): string {
  return projectFileContentUrl(projectId, {
    sourceId,
    path: info.path,
    revision: info.revision,
    download: true,
  });
}

function TextPreview({ projectId, sourceId, info }: FilePreviewProps) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setText(undefined);
    setError(undefined);
    void fetchProjectFileContent(projectId, {
      sourceId,
      path: info.path,
      revision: info.revision,
      signal: controller.signal,
    })
      .then((response) => response.text())
      .then((value) => {
        if (!controller.signal.aborted) setText(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Could not load the file.');
        }
      });
    return () => controller.abort();
  }, [info.path, info.revision, projectId, sourceId]);

  if (error)
    return (
      <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>
        {error}
      </p>
    );
  if (text === undefined)
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading preview…
      </p>
    );
  return <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap text-xs">{text}</pre>;
}

function PreviewError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>
      {message}
    </p>
  );
}

function ImagePreview({ src, name }: { src: string; name: string }) {
  const [error, setError] = useState(false);
  useEffect(() => setError(false), [src]);
  if (error) return <PreviewError message="Could not load this image." />;
  return (
    <img
      src={src}
      alt={name}
      onError={() => setError(true)}
      className="max-h-[55vh] max-w-full rounded object-contain"
    />
  );
}

function useFramePreview(projectId: string, sourceId: string, info: ProjectFileInfo) {
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    setReady(false);
    void headProjectFileContent(projectId, {
      sourceId,
      path: info.path,
      revision: info.revision,
      signal: controller.signal,
    })
      .then(() => {
        if (!controller.signal.aborted) setReady(true);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Could not load this preview.');
      });
    return () => controller.abort();
  }, [attempt, info.path, info.revision, projectId, sourceId]);
  return {
    error,
    ready,
    retry: () => setAttempt((n) => n + 1),
    fail: () => setError('Could not load this preview.'),
  };
}

function FramePreview({
  projectId,
  sourceId,
  info,
  sandbox,
}: {
  projectId: string;
  sourceId: string;
  info: ProjectFileInfo;
  sandbox: string;
}) {
  const src = projectFileContentUrl(projectId, {
    sourceId,
    path: info.path,
    revision: info.revision,
  });
  const { error, ready, retry, fail } = useFramePreview(projectId, sourceId, info);
  if (error)
    return (
      <div className="space-y-2">
        <PreviewError message={error} />
        <button type="button" className="text-xs underline" onClick={retry}>
          Retry preview
        </button>
      </div>
    );
  if (!ready)
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading preview…
      </p>
    );
  return (
    <iframe
      title={info.name}
      src={src}
      sandbox={sandbox}
      onError={fail}
      referrerPolicy="no-referrer"
      className="h-[55vh] w-full rounded border bg-white"
    />
  );
}

export function FilePreview({ projectId, sourceId, info }: FilePreviewProps) {
  const url = projectFileContentUrl(projectId, {
    sourceId,
    path: info.path,
    revision: info.revision,
  });
  const download = downloadLink(projectId, sourceId, info);
  return (
    <section className="space-y-2 min-w-0" aria-label={`Preview of ${info.name}`}>
      <div className="flex items-center justify-between gap-2 min-w-0">
        <h4 className="font-medium truncate">{info.name}</h4>
        <a
          href={download}
          download={info.name}
          className="text-xs underline shrink-0"
          style={{ color: 'var(--accent-hover)' }}
        >
          Download
        </a>
      </div>
      {info.preview === 'text' && (
        <TextPreview projectId={projectId} sourceId={sourceId} info={info} />
      )}
      {info.preview === 'image' && <ImagePreview src={url} name={info.name} />}
      {info.preview === 'pdf' && (
        <PdfPreview projectId={projectId} sourceId={sourceId} info={info} />
      )}
      {info.preview === 'html' && (
        <FramePreview projectId={projectId} sourceId={sourceId} info={info} sandbox="" />
      )}
      {info.preview === 'none' && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Preview unavailable for this file type.
        </p>
      )}
    </section>
  );
}
