import { describe, it, expect } from 'vitest';

// Unit test the context message parsing logic used by the sessions API.
// We replicate the functions here since they are not exported.

interface ParseState {
  title: string;
  snippet: string;
  score: number;
  tags: string[];
}

interface ParsedReference {
  bubbleId: string;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
}

const HEADING_PREFIX_LENGTH = 4;

function classifyLine(line: string, state: ParseState): ParseState {
  if (line.startsWith('### ')) {
    return { title: line.slice(HEADING_PREFIX_LENGTH), snippet: '', score: 0, tags: [] };
  }
  if (line.startsWith('Tags:')) {
    const tagsMatch = /^Tags:\s*(.+?)\s*\|/.exec(line);
    const scoreMatch = /Score:\s*([\d.]+)/.exec(line);
    const rawTags = tagsMatch ? tagsMatch[1] : '';
    const tags =
      rawTags === 'none'
        ? []
        : rawTags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    return { ...state, score, tags };
  }
  if (!line.startsWith('[ref:') && line.trim()) {
    return { ...state, snippet: line };
  }
  return state;
}

function parseContextMessage(
  content: string,
  taskId: string,
): { taskId: string; refs: ParsedReference[] } {
  const refs: ParsedReference[] = [];
  const lines = content.split('\n');
  let state: ParseState = { title: '', snippet: '', score: 0, tags: [] };

  for (const line of lines) {
    state = classifyLine(line, state);
    const refMatch = /\[ref:\s*([^\]]+)\]/.exec(line);
    if (refMatch) {
      const bubbleId = refMatch[1].trim();
      if (!refs.some((r) => r.bubbleId === bubbleId)) {
        refs.push({
          bubbleId,
          title: state.title,
          snippet: state.snippet,
          score: state.score,
          tags: state.tags,
        });
      }
    }
  }
  return { taskId, refs };
}

describe('Session reference parsing', () => {
  it('parses a context message with score and tags', () => {
    const content = [
      '### Project Alpha Overview',
      'Tags: projects, planning | Score: 0.87 | Source: full-content',
      'Project Alpha is a multi-phase initiative...',
      '[ref: bubble-123]',
      '',
    ].join('\n');

    const { refs } = parseContextMessage(content, 'task-1');
    expect(refs).toHaveLength(1);
    expect(refs[0].bubbleId).toBe('bubble-123');
    expect(refs[0].title).toBe('Project Alpha Overview');
    expect(refs[0].snippet).toBe('Project Alpha is a multi-phase initiative...');
    expect(refs[0].score).toBe(0.87);
    expect(refs[0].tags).toEqual(['projects', 'planning']);
  });

  it('parses multiple references from a single context message', () => {
    const content = [
      '### First Bubble',
      'Tags: tag1 | Score: 0.90 | Source: chunk',
      'First content here.',
      '[ref: bubble-aaa]',
      '',
      '### Second Bubble',
      'Tags: tag2, tag3 | Score: 0.55 | Source: full-content',
      'Second content here.',
      '[ref: bubble-bbb]',
      '',
    ].join('\n');

    const { refs } = parseContextMessage(content, 'task-1');
    expect(refs).toHaveLength(2);
    expect(refs[0].bubbleId).toBe('bubble-aaa');
    expect(refs[0].score).toBe(0.9);
    expect(refs[0].tags).toEqual(['tag1']);
    expect(refs[1].bubbleId).toBe('bubble-bbb');
    expect(refs[1].score).toBe(0.55);
    expect(refs[1].tags).toEqual(['tag2', 'tag3']);
  });

  it('handles "none" tags', () => {
    const content = [
      '### No Tags Bubble',
      'Tags: none | Score: 0.42 | Source: chunk',
      'Some content.',
      '[ref: bubble-notags]',
    ].join('\n');

    const { refs } = parseContextMessage(content, 'task-1');
    expect(refs).toHaveLength(1);
    expect(refs[0].tags).toEqual([]);
    expect(refs[0].score).toBe(0.42);
  });

  it('deduplicates references by bubbleId', () => {
    const content = [
      '### Same Bubble',
      'Tags: none | Score: 0.70 | Source: chunk',
      'Content A.',
      '[ref: bubble-dup]',
      '',
      '### Same Bubble',
      'Tags: none | Score: 0.65 | Source: chunk',
      'Content B.',
      '[ref: bubble-dup]',
    ].join('\n');

    const { refs } = parseContextMessage(content, 'task-1');
    expect(refs).toHaveLength(1);
    expect(refs[0].bubbleId).toBe('bubble-dup');
  });

  it('handles empty content', () => {
    const { refs } = parseContextMessage('', 'task-1');
    expect(refs).toHaveLength(0);
  });

  it('handles content without ref markers', () => {
    const content = [
      '### Some Title',
      'Tags: test | Score: 0.80 | Source: chunk',
      'Content without a ref marker.',
    ].join('\n');

    const { refs } = parseContextMessage(content, 'task-1');
    expect(refs).toHaveLength(0);
  });
});
