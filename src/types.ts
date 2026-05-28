export interface ReportingLangSet {
  /** Message when exception is filtered out */
  exceptionFiltered: string;
  /** Message when test is quarantined (skipped by SkipOnError) */
  quarantined: string;
  /** Message when Jira is unavailable */
  jiraUnavailable: string;
  /** Message when existing issue found */
  issueExists: string;
  /** Message when new issue created */
  issueCreated: string;
  /** Message for dry-run mode */
  dryRun: string;
  /** Template for issue summary. Placeholders: {testName}, {priority} */
  summaryTemplate: string;
  /** Template for issue description. Placeholders: {testName}, {testPath}, {error}, {traceback}, {jobLink}, {projectName} */
  descriptionTemplate: string;
  /** Template for comment on existing issue. Placeholders: {testName}, {error}, {traceback}, {jobLink}, {failureCount} */
  commentTemplate: string;
}

export type ReportingLangKey = 'en' | 'ru';

export interface FlakyzavrConfig {
  /** Jira server URL, e.g. "https://jira.example.com" */
  jiraServer: string;
  /** Jira API token for authentication */
  jiraToken: string;
  /** Jira project key, e.g. "QA" */
  jiraProject: string;

  /** Auth type: "cloud" (Basic with email:token) or "server" (Bearer token). Default: "server" */
  jiraAuthType?: 'cloud' | 'server';
  /** Jira account email, required when jiraAuthType is "cloud" */
  jiraEmail?: string;

  /** Jira components to assign to created issues */
  jiraComponents?: string[];
  /** Jira labels to assign, default: ["flaky"] */
  jiraLabels?: string[];
  /** Jira issue type ID or name, default: "Bug" */
  jiraIssueTypeId?: string;
  /** Jira statuses to search for existing issues, default: ["Open", "In Progress", "Reopened"] */
  jiraSearchStatuses?: string[];
  /** Additional Jira fields to set on created issues */
  jiraAdditionalData?: Record<string, unknown>;

  /** Enable/disable reporting, default: true */
  reportEnabled?: boolean;
  /** Dry-run mode — log only, don't create issues, default: false */
  dryRun?: boolean;
  /** Project name for display in reports */
  reportProjectName?: string;
  /** CI/CD job URL template. Use {job_id} placeholder, e.g. "https://ci.example.com/jobs/{job_id}" */
  jobPath?: string;

  /** Regex patterns for errors to skip (don't create issues for matching errors) */
  exceptions?: string[];

  /** Reporting language: "en" or "ru", default: "en" */
  reportingLang?: ReportingLangKey;

  /** Group all failing tests from the same file under one Jira issue. Default: false */
  groupByFile?: boolean;
  /**
   * If the number of failing tests from the same file reaches this threshold,
   * group them under one Jira issue instead of creating individual tickets.
   * Below the threshold each test gets its own ticket.
   */
  groupByFileThreshold?: number;
  /**
   * Group all tests that fail with the same error under one Jira issue.
   * Matching is done by the first line of the error message.
   * Useful when infrastructure failures (DB down, timeout) cause mass test failures.
   */
  groupSameError?: boolean;

  /**
   * Prefix prepended to every Jira issue summary, e.g. "[QA][TsTest]".
   * Set to empty string "" to disable.
   * Default: "[QA][TsTest]"
   */
  summaryPrefix?: string;
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: {
      name: string;
    };
  };
}

export interface JiraSearchResult {
  total: number;
  issues: JiraIssue[];
}

export interface JiraCreateResult {
  key: string;
  id: string;
  self: string;
}
