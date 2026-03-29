/**
 * Task-board protocol — generates system prompt instructions
 * that give agents awareness of their execution context.
 */

export function buildTaskBoardInstructions(parentTaskId?: string, retryFeedback?: string): string {
  const sections: string[] = [];

  if (retryFeedback) {
    sections.push(
      '## Previous Attempt Failed',
      '',
      'Your previous attempt at this task did not pass validation.',
      'Review the feedback below and address the issues in this attempt:',
      '',
      retryFeedback,
      '',
    );
  }

  sections.push('## Task Execution Protocol', '');

  if (parentTaskId) {
    sections.push(`Your work is tracked under parent task \`${parentTaskId}\`.`, '');
  }

  sections.push(
    'Follow these guidelines for task execution:',
    '',
    '- **Artifacts**: Save any output files to the `data/artifacts/` directory.',
    '- **Summary**: When done, provide a concise summary of what was accomplished.',
    '- **Blocking**: If you are blocked, explain clearly what is preventing progress.',
    '',
    'When you finish, respond with your status in this format:',
    '',
    '```',
    'STATUS: COMPLETED | BLOCKED | NEEDS_REPLAN',
    'SUMMARY: Brief description of what was done or what is blocking.',
    'ARTIFACTS:',
    '- path/to/file1 — description',
    '- path/to/file2 — description',
    '```',
    '',
    'Use STATUS: COMPLETED when the task is done.',
    'Use STATUS: BLOCKED when you cannot proceed without external input.',
    'Use STATUS: NEEDS_REPLAN when the task needs to be restructured.',
  );

  return sections.join('\n');
}
