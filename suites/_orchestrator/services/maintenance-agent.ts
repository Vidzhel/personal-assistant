import { createLogger } from '@raven/shared';
import type { LogAnalysisResult } from './log-analyzer.ts';
import type { DependencyReport } from './dependency-checker.ts';
import type { ResourceReport } from './resource-monitor.ts';
import type { SuiteUpdateReport } from './suite-update-checker.ts';

const log = createLogger('maintenance-agent');

export interface MaintenanceData {
  logAnalysis: LogAnalysisResult;
  dependencyReport: DependencyReport;
  resourceReport: ResourceReport;
  suiteUpdateReport: SuiteUpdateReport;
  runDate: string;
}

export function buildMaintenancePrompt(data: MaintenanceData): string {
  log.info('Building maintenance agent prompt');

  const sections: string[] = [
    buildRoleSection(),
    buildLogSection(data.logAnalysis),
    buildDependencySection(data.dependencyReport),
    buildResourceSection(data.resourceReport),
    buildSuiteSection(data.suiteUpdateReport),
    buildOutputInstructions(),
  ];

  return sections.join('\n\n---\n\n');
}

function buildRoleSection(): string {
  return `You are Raven's System Maintenance Agent. Your job is to analyze the system data below and produce a structured maintenance report.

You MUST use web search to:
1. Look up fixes for any recurring errors you find — search Stack Overflow, GitHub issues, and relevant documentation
2. Search GitHub for MCP servers and integration tools that could extend Raven's capabilities based on installed suites
3. Find migration guides and changelog highlights for any outdated packages before recommending upgrades
4. Search for community reports of breaking changes for major version updates

Be thorough in your web research. The value of this report comes from actionable recommendations backed by external sources.`;
}

function buildLogSection(analysis: LogAnalysisResult): string {
  const lines: string[] = ['## System Logs (Last 7 Days)'];

  if (analysis.recurringErrors.length === 0 && analysis.silentFailures.length === 0) {
    lines.push('No recurring errors or silent failures detected.');
    return lines.join('\n');
  }

  if (analysis.recurringErrors.length > 0) {
    lines.push('### Recurring Errors');
    for (const err of analysis.recurringErrors) {
      lines.push(`- **${err.component}**: "${err.pattern}" — ${String(err.count)} occurrences`);
      if (err.lastSeen) {
        lines.push(`  Last seen: ${err.lastSeen}`);
      }
    }
  }

  if (analysis.silentFailures.length > 0) {
    lines.push('### Silent Failures (services with no recent log output)');
    for (const sf of analysis.silentFailures) {
      lines.push(`- **${sf.component}**: last log entry at ${sf.lastEntry}`);
    }
  }

  lines.push(
    `\nTotal errors: ${String(analysis.totalErrors)}, Total warnings: ${String(analysis.totalWarnings)}`,
  );

  return lines.join('\n');
}

function buildDependencySection(report: DependencyReport): string {
  const lines: string[] = ['## Dependency Status'];

  if (report.outdated.length === 0 && report.vulnerabilities.length === 0) {
    lines.push('All packages are up to date. No security advisories.');
    return lines.join('\n');
  }

  if (report.outdated.length > 0) {
    lines.push('### Outdated Packages');
    for (const pkg of report.outdated) {
      lines.push(`- **${pkg.name}**: ${pkg.current} → ${pkg.latest} (${pkg.updateType})`);
    }
  }

  if (report.vulnerabilities.length > 0) {
    lines.push('### Security Advisories');
    for (const vuln of report.vulnerabilities) {
      lines.push(`- **${vuln.name}**: ${vuln.severity} — ${vuln.title}`);
      if (vuln.url) {
        lines.push(`  Advisory: ${vuln.url}`);
      }
    }
  }

  return lines.join('\n');
}

function buildResourceSection(report: ResourceReport): string {
  const lines: string[] = ['## Resource Status'];

  lines.push(`- Database size: ${report.dbSizeMB.toFixed(1)} MB`);
  lines.push(`- Log volume: ${report.logSizeMB.toFixed(1)} MB`);
  lines.push(`- Session data: ${report.sessionSizeMB.toFixed(1)} MB`);

  if (report.healthStatus) {
    lines.push(`- System status: ${report.healthStatus.status}`);
    lines.push(
      `- Memory: ${report.healthStatus.heapUsedMB.toFixed(1)} / ${report.healthStatus.heapTotalMB.toFixed(1)} MB`,
    );
    if (report.healthStatus.failureRate !== undefined) {
      lines.push(
        `- Task failure rate (1h): ${(report.healthStatus.failureRate * 100).toFixed(1)}%`,
      );
    }
  }

  if (report.concerns.length > 0) {
    lines.push('### Concerns');
    for (const concern of report.concerns) {
      lines.push(`- ⚠️ ${concern}`);
    }
  }

  return lines.join('\n');
}

function buildSuiteSection(report: SuiteUpdateReport): string {
  const lines: string[] = ['## Suite Ecosystem'];

  if (report.suitesWithUpdates.length > 0) {
    lines.push('### Suites with UPDATE.md');
    for (const suite of report.suitesWithUpdates) {
      lines.push(`- **${suite.name}**: ${suite.checkInstructions}`);
    }
  }

  if (report.suitesWithoutUpdates.length > 0) {
    lines.push('### Suites Missing UPDATE.md');
    for (const name of report.suitesWithoutUpdates) {
      lines.push(`- ${name}`);
    }
  }

  lines.push(`\nInstalled suites: ${report.installedSuites.join(', ')}`);
  lines.push('\nSearch GitHub for MCP servers and tools that complement the installed suites.');

  return lines.join('\n');
}

function buildOutputInstructions(): string {
  return `## Output Format

Produce your report in this exact Markdown structure:

# Raven Maintenance Report — {date}

## 🔴 Issues Found
List each issue with:
- Description of the problem
- Web-sourced fix or workaround (include links)
- Recommended action

If no issues: "No issues found."

## 📦 Package Updates
For each outdated package:
- Package name, current → latest version
- Update type (patch/minor/major/security)
- Migration notes from changelog/guides (include links)

If all up to date: "All packages are current."

## 💡 Suite Suggestions
- New MCP servers or tools found on GitHub that could extend capabilities
- Suggestions based on detected usage patterns
- Links to repositories

If none: "No new suggestions at this time."

## 📊 Resource Status
- Database, logs, sessions sizes
- Memory usage
- Any threshold concerns

Keep the report concise but actionable. Every recommendation must include a source link from your web research.`;
}
