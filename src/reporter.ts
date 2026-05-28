import path from 'path';
import type {
  Reporter,
  TestCase,
  TestResult,
  FullConfig,
  Suite,
  FullResult,
} from '@playwright/test/reporter';

import { FlakyzavrConfig, ReportingLangSet } from './types.js';
import { JiraClient } from './jira-client.js';
import { getLangSet, renderTemplate } from './messages.js';

interface FailureRecord {
  testName: string;
  testPath: string;
  testLine: number;
  errorMessage: string;
  traceback: string;
  snippet: string;
  pageSnapshot: string;
  jobLink: string;
}

export class FlakyzavrReporter implements Reporter {
  private config: Required<Pick<FlakyzavrConfig, 'jiraServer' | 'jiraToken' | 'jiraProject'>> &
    FlakyzavrConfig;
  private lang: ReportingLangSet;
  private client: JiraClient | null = null;
  private exceptionPatterns: RegExp[];

  private stats = { created: 0, commented: 0, filtered: 0, errors: 0, skipped: 0 };
  private pendingFailures = new Map<string, FailureRecord[]>();

  constructor(config: FlakyzavrConfig) {
    this.validateConfig(config);

    this.config = {
      jiraLabels: ['flaky'],
      jiraIssueTypeId: 'Bug',
      jiraSearchStatuses: ['Open', 'In Progress', 'Reopened'],
      reportEnabled: true,
      dryRun: false,
      reportProjectName: config.jiraProject,
      reportingLang: 'en',
      ...config,
    };

    this.lang = getLangSet(this.config.reportingLang!);
    this.exceptionPatterns = (this.config.exceptions ?? []).map((p) => new RegExp(p));
  }

  private validateConfig(config: FlakyzavrConfig): void {
    const missing: string[] = [];
    if (!config.jiraServer) missing.push('jiraServer');
    if (!config.jiraToken) missing.push('jiraToken');
    if (!config.jiraProject) missing.push('jiraProject');

    if (missing.length > 0) {
      throw new Error(
        `[flakyzavr] Missing required config: ${missing.join(', ')}. ` +
          `Provide them in playwright.config.ts reporter options.`,
      );
    }

    try {
      new URL(config.jiraServer);
    } catch {
      throw new Error(
        `[flakyzavr] Invalid jiraServer URL: "${config.jiraServer}". ` +
          `Must be a valid URL (e.g. "https://jira.example.com").`,
      );
    }

    if (config.jiraAuthType === 'cloud' && !config.jiraEmail) {
      throw new Error(`[flakyzavr] jiraEmail is required when jiraAuthType is "cloud".`);
    }
  }

  private getClient(): JiraClient {
    if (!this.client) {
      this.client = new JiraClient({
        server: this.config.jiraServer,
        token: this.config.jiraToken,
        authType: this.config.jiraAuthType,
        email: this.config.jiraEmail,
      });
    }
    return this.client;
  }

  onBegin(_config: FullConfig, _suite: Suite): void {
    // no-op
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    if (!this.config.reportEnabled) return;
    if (result.status === 'passed') return;

    if (result.status === 'skipped') {
      const testName = test.titlePath().slice(1).join(' > ');
      console.log(renderTemplate(this.lang.quarantined, { testName }));
      this.stats.skipped++;
      return;
    }

    const testName = test.titlePath().slice(1).join(' > ');
    const errorMessage = result.error?.message ?? 'Unknown error';

    if (this.isExceptionFiltered(errorMessage)) {
      console.log(renderTemplate(this.lang.exceptionFiltered, { testName }));
      this.stats.filtered++;
      return;
    }

    const jobLink = this.buildJobLink();

    const failure: FailureRecord = {
      testName,
      testPath: test.location.file,
      testLine: test.location.line,
      errorMessage,
      traceback: result.error?.stack ?? '',
      snippet: result.error?.snippet ?? '',
      pageSnapshot: this.extractPageSnapshot(result),
      jobLink,
    };

    if (this.config.groupByFileThreshold !== undefined || this.config.groupSameError) {
      const fileKey = path.relative(process.cwd(), test.location.file);
      const list = this.pendingFailures.get(fileKey) ?? [];
      list.push(failure);
      this.pendingFailures.set(fileKey, list);
    } else if (this.config.dryRun) {
      console.log(renderTemplate(this.lang.dryRun, { testName }));
    } else {
      const issueTestName = this.getIssueTestName(test);
      await this.reportFailure(issueTestName, failure);
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (!this.config.reportEnabled) return;

    if (this.config.groupSameError) {
      const allFailures = [...this.pendingFailures.values()].flat();
      await this.processGroupedByError(allFailures);
    } else if (this.config.groupByFileThreshold !== undefined) {
      const threshold = this.config.groupByFileThreshold;
      for (const [fileKey, failures] of this.pendingFailures) {
        if (failures.length >= threshold) {
          await this.reportFileGroup(fileKey, failures);
        } else {
          for (const failure of failures) {
            await this.reportFailure(failure.testName, failure);
          }
        }
      }
    }

    const { created, commented, filtered, errors, skipped } = this.stats;
    if (created || commented || filtered || errors || skipped) {
      console.log(
        `[flakyzavr] Summary: ${created} created, ${commented} commented, ` +
          `${filtered} filtered, ${errors} errors, ${skipped} quarantined`,
      );
    }
  }

  private stripAnsi(str: string): string {
    return str
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\([^)]*\)/g, '')
      .replace(/\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/[\u001b\u0000-\u001f\u007f]/g, '');
  }

  private truncateTestName(testName: string): string {
    const MAX_SUMMARY_LENGTH = 255;
    const cleanedName = testName.replace(/[\r\n]+/g, ' ').trim();
    if (cleanedName.length <= MAX_SUMMARY_LENGTH) {
      return cleanedName;
    }
    const lastSlash = Math.max(cleanedName.lastIndexOf('/'), cleanedName.lastIndexOf('\\'));
    if (lastSlash !== -1) {
      const fileName = cleanedName.substring(lastSlash + 1);
      if (fileName.length <= MAX_SUMMARY_LENGTH) {
        return fileName;
      }
    }
    return cleanedName.substring(0, MAX_SUMMARY_LENGTH);
  }

  private getErrorKey(errorMessage: string): string {
    return this.stripAnsi(errorMessage.split('\n')[0].trim());
  }

  private async processGroupedByError(failures: FailureRecord[]): Promise<void> {
    const byError = new Map<string, FailureRecord[]>();
    for (const failure of failures) {
      const key = this.getErrorKey(failure.errorMessage);
      const list = byError.get(key) ?? [];
      list.push(failure);
      byError.set(key, list);
    }

    for (const [errorKey, group] of byError) {
      if (group.length === 1) {
        await this.reportFailure(group[0].testName, group[0]);
      } else {
        await this.reportErrorGroup(errorKey, group);
      }
    }
  }

  private async reportErrorGroup(errorKey: string, failures: FailureRecord[]): Promise<void> {
    const first = failures[0];
    const testNames = failures.map((f) => f.testName).join('\n- ');
    const additionalSections = this.buildAdditionalSections(first);
    const safeErrorKey = this.stripAnsi(errorKey);
    const fullGroupSummary = renderTemplate(this.lang.summaryTemplate, {
      testName: safeErrorKey,
      projectName: this.config.reportProjectName!,
    });
    const truncatedErrorKey = this.truncateTestName(fullGroupSummary);

    const groupDescription =
      `h3. Multiple tests failed with the same error\n\n` +
      `*Error:* ${safeErrorKey}\n\n` +
      `*Failed tests (${failures.length}):*\n- ${testNames}\n\n` +
      `h3. Full error\n{noformat}${first.errorMessage}{noformat}\n\n` +
      additionalSections +
      (first.jobLink ? `[Job link|${first.jobLink}]\n` : '');

    const groupComment =
      `h3. Tests failed again with the same error\n\n` +
      `*Error:* ${safeErrorKey}\n\n` +
      `*Failed tests (${failures.length}):*\n- ${testNames}\n\n` +
      (first.jobLink ? `[Job link|${first.jobLink}]\n` : '');

    await this.reportFailure(truncatedErrorKey, first, groupDescription, groupComment);
  }

  private async reportFileGroup(fileKey: string, failures: FailureRecord[]): Promise<void> {
    const first = failures[0];
    const testNames = failures.map((f) => f.testName).join('\n- ');
    const combinedErrors = failures
      .map((f) => `[${f.testName}]\n${f.errorMessage}`)
      .join('\n\n---\n\n');
    const combinedSnapshots = failures
      .filter((f) => f.pageSnapshot)
      .map((f) => `[${f.testName}]\n${f.pageSnapshot}`)
      .join('\n\n---\n\n');
    const snapshotHeader = 'Page snapshots';
    const fullFileSummary = renderTemplate(this.lang.summaryTemplate, {
      testName: fileKey,
      projectName: this.config.reportProjectName!,
    });
    const truncatedFileKey = this.truncateTestName(fullFileSummary);

    const groupDescription =
      `h3. Multiple tests failed in the same file\n\n` +
      `*File:* ${fileKey}\n` +
      `*Failed tests (${failures.length}):*\n- ${testNames}\n\n` +
      `h3. Errors\n{noformat}${combinedErrors}{noformat}\n\n` +
      (combinedSnapshots
        ? `h3. ${snapshotHeader}\n{noformat}${combinedSnapshots}{noformat}\n\n`
        : '') +
      (first.jobLink ? `[Job link|${first.jobLink}]\n` : '');

    const groupComment =
      `h3. Tests failed again in ${fileKey}\n\n` +
      `*Failed tests (${failures.length}):*\n- ${testNames}\n\n` +
      (first.jobLink ? `[Job link|${first.jobLink}]\n` : '');

    await this.reportFailure(truncatedFileKey, first, groupDescription, groupComment);
  }

  private async reportFailure(
    issueTestName: string,
    failure: FailureRecord,
    overrideDescription?: string,
    overrideComment?: string,
  ): Promise<void> {
    if (this.config.dryRun) {
      console.log(renderTemplate(this.lang.dryRun, { testName: issueTestName }));
      return;
    }
    const { testName, testPath, testLine, errorMessage, traceback, jobLink } = failure;
    const additionalSections = this.buildAdditionalSections(failure);
    try {
      const client = this.getClient();

      const truncatedTestName = this.truncateTestName(issueTestName);
      const searchResult = await client.searchIssues(
        this.config.jiraProject,
        truncatedTestName,
        this.config.jiraLabels!,
        this.config.jiraSearchStatuses!,
      );

      if (searchResult.total > 0) {
        const existingIssue = searchResult.issues[0];
        const comment =
          overrideComment ??
          renderTemplate(this.lang.commentTemplate, {
            testName,
            error: errorMessage,
            traceback,
            jobLink,
            failureCount: String(searchResult.total + 1),
            additionalSections,
          });

        await client.addComment(existingIssue.key, comment);
        console.log(
          renderTemplate(this.lang.issueExists, {
            issueKey: existingIssue.key,
            testName: issueTestName,
          }),
        );
        this.stats.commented++;
      } else {
        const fullSummary = renderTemplate(this.lang.summaryTemplate, {
          testName: issueTestName,
          projectName: this.config.reportProjectName!,
        });
        const summary = this.truncateTestName(fullSummary);
        const description =
          overrideDescription ??
          renderTemplate(this.lang.descriptionTemplate, {
            testName,
            testPath,
            testLine: String(testLine),
            error: errorMessage,
            traceback,
            jobLink,
            projectName: this.config.reportProjectName!,
            additionalSections,
          });

        const created = await client.createIssue({
          project: this.config.jiraProject,
          summary,
          description,
          issueType: this.config.jiraIssueTypeId!,
          components: this.config.jiraComponents,
          labels: this.config.jiraLabels,
          additionalData: this.config.jiraAdditionalData,
        });

        console.log(
          renderTemplate(this.lang.issueCreated, {
            issueKey: created.key,
            testName: issueTestName,
          }),
        );
        this.stats.created++;
      }
    } catch (err: any) {
      const status = err.response?.status;
      const responseData = err.response?.data;
      const errorDetails = err.response
        ? `Status: ${status}, Response: ${JSON.stringify(responseData)}`
        : err.message;
      console.error(`[flakyzavr] Jira error: ${errorDetails}`);
      if (err.stack) {
        console.error(err.stack);
      }
      this.stats.errors++;
    }
  }

  private getIssueTestName(test: TestCase): string {
    if (this.config.groupByFile) {
      return path.basename(test.location.file);
    }
    return test.title;
  }

  private isExceptionFiltered(errorMessage: string): boolean {
    return this.exceptionPatterns.some((pattern) => pattern.test(errorMessage));
  }

  private buildJobLink(): string {
    if (!this.config.jobPath) return '';

    const jobId = process.env.CI_JOB_ID ?? process.env.BUILD_ID ?? process.env.GITHUB_RUN_ID ?? '';

    return this.config.jobPath.replace('{job_id}', jobId);
  }

  private extractPageSnapshot(result: TestResult): string {
    if (!result.attachments) return '';
    for (const attachment of result.attachments) {
      if (/snapshot/i.test(attachment.name) && attachment.body) {
        return attachment.body.toString('utf-8');
      }
    }
    return '';
  }

  private buildAdditionalSections(failure: FailureRecord): string {
    let sections = '';
    if (failure.snippet) {
      const header = 'Source';
      sections += `h3. ${header}\n{noformat}${failure.snippet}{noformat}\n\n`;
    }
    if (failure.pageSnapshot) {
      const header = 'Page snapshot';
      sections += `h3. ${header}\n{noformat}${failure.pageSnapshot}{noformat}\n\n`;
    }

    return sections;
  }
}
