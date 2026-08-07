import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, generateId, SOURCE_MAINTENANCE } from '@raven/shared';
import type { EventBusInterface } from '@raven/shared';
import type { LogAnalysisResult } from './log-analyzer.ts';
import type { DependencyReport } from './dependency-checker.ts';
import type { ResourceReport } from './resource-monitor.ts';
import type { SuiteUpdateReport } from './suite-update-checker.ts';
import type { ConventionAuditReport } from './convention-auditor.ts';

const log = createLogger('maintenance-report');

export interface MaintenanceReportData {
  logAnalysis: LogAnalysisResult;
  dependencyReport: DependencyReport;
  resourceReport: ResourceReport;
  suiteUpdateReport: SuiteUpdateReport;
  conventionAuditReport?: ConventionAuditReport;
  agentAnalysis?: string;
}

export interface CompiledReport {
  markdown: string;
  date: string;
  filePath: string;
}

export async function compileReport(
  data: MaintenanceReportData,
  reportsDir: string,
): Promise<CompiledReport> {
  log.info('Compiling maintenance report');

  const date = new Date().toISOString().split('T')[0];
  const markdown = data.agentAnalysis ?? buildFallbackReport(data, date);
  const filePath = join(reportsDir, `${date}.md`);

  await mkdir(reportsDir, { recursive: true });
  await writeFile(filePath, markdown, 'utf-8');

  log.info(`Report saved to ${filePath}`);
  return { markdown, date, filePath };
}

export function emitReportEvent(eventBus: EventBusInterface, report: CompiledReport): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_MAINTENANCE,
    type: 'maintenance:report:generated',
    payload: {
      date: report.date,
      filePath: report.filePath,
      reportLength: report.markdown.length,
    },
  });

  log.info('Emitted maintenance:report:generated event');
}

export function sendReportNotification(eventBus: EventBusInterface, report: CompiledReport): void {
  // Truncate for Telegram if needed (4096 char limit for messages)
  const MAX_TELEGRAM_LENGTH = 3800;
  const body =
    report.markdown.length > MAX_TELEGRAM_LENGTH
      ? report.markdown.slice(0, MAX_TELEGRAM_LENGTH) +
        '\n\n_...report truncated. Full report saved to disk._'
      : report.markdown;

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_MAINTENANCE,
    type: 'notification',
    payload: {
      channel: 'telegram' as const,
      title: `System Maintenance Report — ${report.date}`,
      body,
      topicName: 'Raven System',
    },
  });

  log.info('Sent maintenance report notification');
}

function buildIssuesSection(logAnalysis: LogAnalysisResult): string[] {
  const lines: string[] = ['## 🔴 Issues Found'];
  if (logAnalysis.recurringErrors.length > 0 || logAnalysis.silentFailures.length > 0) {
    for (const err of logAnalysis.recurringErrors) {
      lines.push(
        `- **${err.component}**: "${err.pattern}" — ${String(err.count)} occurrences (last: ${err.lastSeen})`,
      );
    }
    for (const sf of logAnalysis.silentFailures) {
      lines.push(`- **Silent**: ${sf.component} — last seen ${sf.lastEntry}`);
    }
  } else {
    lines.push('No issues found.');
  }
  lines.push('');
  return lines;
}

function buildPackageUpdatesSection(dependencyReport: DependencyReport): string[] {
  const lines: string[] = ['## 📦 Package Updates'];
  if (dependencyReport.outdated.length > 0) {
    for (const pkg of dependencyReport.outdated) {
      lines.push(`- **${pkg.name}**: ${pkg.current} → ${pkg.latest} (${pkg.updateType})`);
    }
  } else {
    lines.push('All packages are current.');
  }
  if (dependencyReport.vulnerabilities.length > 0) {
    lines.push('### Security Advisories');
    for (const vuln of dependencyReport.vulnerabilities) {
      lines.push(`- **${vuln.name}** [${vuln.severity}]: ${vuln.title}`);
    }
  }
  lines.push('');
  return lines;
}

function buildSuiteSuggestionsSection(suiteUpdateReport: SuiteUpdateReport): string[] {
  const lines: string[] = ['## 💡 Suite Suggestions'];
  if (suiteUpdateReport.suitesWithoutUpdates.length > 0) {
    lines.push('Suites missing UPDATE.md:');
    for (const name of suiteUpdateReport.suitesWithoutUpdates) {
      lines.push(`- ${name}`);
    }
  } else {
    lines.push('No new suggestions at this time.');
  }
  lines.push('');
  return lines;
}

function buildConventionComplianceSection(conventionAuditReport?: ConventionAuditReport): string[] {
  const lines: string[] = ['## 🔍 Convention Compliance'];
  if (conventionAuditReport && conventionAuditReport.violations.length > 0) {
    const report = conventionAuditReport;
    lines.push(
      `${String(report.violations.length)} violations found across ${String(report.totalChecked)} resources:`,
    );
    const byType = new Map<string, typeof report.violations>();
    for (const v of report.violations) {
      const existing = byType.get(v.resourceType) ?? [];
      existing.push(v);
      byType.set(v.resourceType, existing);
    }
    for (const [type, violations] of byType) {
      lines.push(`### ${type}`);
      for (const v of violations) {
        lines.push(`- **${v.resourceName}** [${v.severity}]: ${v.message} — Fix: ${v.fix}`);
      }
    }
  } else {
    lines.push('All resources follow conventions.');
  }
  lines.push('');
  return lines;
}

function buildResourceStatusSection(resourceReport: ResourceReport): string[] {
  const lines: string[] = ['## 📊 Resource Status'];
  lines.push(`- Database: ${resourceReport.dbSizeMB.toFixed(1)} MB`);
  lines.push(`- Logs: ${resourceReport.logSizeMB.toFixed(1)} MB`);
  lines.push(`- Sessions: ${resourceReport.sessionSizeMB.toFixed(1)} MB`);
  if (resourceReport.healthStatus) {
    lines.push(`- Status: ${resourceReport.healthStatus.status}`);
    lines.push(
      `- Memory: ${resourceReport.healthStatus.heapUsedMB.toFixed(1)}/${resourceReport.healthStatus.heapTotalMB.toFixed(1)} MB`,
    );
  }
  if (resourceReport.concerns.length > 0) {
    for (const concern of resourceReport.concerns) {
      lines.push(`- ⚠️ ${concern}`);
    }
  }
  return lines;
}

function buildFallbackReport(data: MaintenanceReportData, date: string): string {
  const lines: string[] = [
    `# Raven Maintenance Report — ${date}`,
    '',
    ...buildIssuesSection(data.logAnalysis),
    ...buildPackageUpdatesSection(data.dependencyReport),
    ...buildSuiteSuggestionsSection(data.suiteUpdateReport),
    ...buildConventionComplianceSection(data.conventionAuditReport),
    ...buildResourceStatusSection(data.resourceReport),
  ];

  return lines.join('\n');
}
