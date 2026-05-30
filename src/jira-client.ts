import { Version2Client } from 'jira.js';
import { JiraSearchResult, JiraCreateResult } from './types.js';

export interface JiraClientConfig {
  server: string;
  token: string;
  authType?: 'cloud' | 'server';
  email?: string;
}

let globalJar: string | null = null;

export class JiraClient {
  private readonly client: Version2Client;

  constructor(config: JiraClientConfig) {
    const authType = config.authType ?? 'server';

    if (authType === 'cloud' && !config.email) {
      throw new Error('[flakyzavr] jiraEmail is required when jiraAuthType is "cloud"');
    }

    const serverUrl = config.server.replace(/\/+$/, '');

    this.client = new Version2Client({
      host: serverUrl,
      authentication:
        authType === 'cloud'
          ? { basic: { email: config.email!, apiToken: config.token } }
          : { oauth2: { accessToken: config.token } }, // We use oauth2 block to pass Bearer PAT token in jira.js
      baseRequestConfig: {
        maxRedirects: 0,
      },
    });

    const anyClient = this.client as any;
    if (anyClient.instance && anyClient.instance.interceptors) {
      anyClient.instance.interceptors.response.use(
        (response: any) => response,
        async (error: any) => {
          const originalRequest = error.config;
          const status = error.response?.status;

          if (status === 307 || status === 302 || status === 301) {
            const setCookie = error.response.headers['set-cookie'];
            if (setCookie) {
              globalJar = Array.isArray(setCookie)
                ? setCookie[0].split(';')[0]
                : setCookie.split(';')[0];
            }

            if (globalJar) {
              if (!originalRequest.headers) {
                originalRequest.headers = {};
              }
              originalRequest.headers['Cookie'] = globalJar;
            }

            const location = error.response.headers['location'];
            if (location) {
              originalRequest.url = location.startsWith('http') ? location : serverUrl + location;
            }

            // Retry the request with the new cookie and location
            return anyClient.instance(originalRequest);
          }

          return Promise.reject(error);
        },
      );
    }
  }

  async searchIssues(
    project: string,
    testIdentifier: string,
    _labels: string[],
    statuses: string[],
  ): Promise<JiraSearchResult> {
    const statusJql = statuses.map((s) => `"${s}"`).join(', ');

    const jql = [
      `project = "${project}"`,
      `status in (${statusJql})`,
      `summary ~ "${this.escapeJql(testIdentifier)}"`,
    ].join(' AND ');

    const result = await this.client.issueSearch.searchForIssuesUsingJql({ jql, maxResults: 1 });

    return {
      total: result.total ?? 0,
      issues: (result.issues ?? []).map((i) => ({
        key: i.key,
        fields: {
          summary: i.fields?.summary ?? '',
          status: { name: i.fields?.status?.name ?? '' },
        },
      })),
    };
  }

  async createIssue(params: {
    project: string;
    summary: string;
    description: string;
    issueType: string;
    components?: string[];
    labels?: string[];
    additionalData?: Record<string, unknown>;
  }): Promise<JiraCreateResult> {
    const fields: Record<string, unknown> = {
      project: { key: params.project },
      summary: params.summary,
      description: params.description,
      issuetype: { name: params.issueType },
    };

    if (params.labels?.length) {
      fields.labels = params.labels;
    }

    if (params.components?.length) {
      fields.components = params.components.map((name) => ({ name }));
    }

    if (params.additionalData) {
      Object.assign(fields, params.additionalData);
    }

    const created = await this.client.issues.createIssue({
      fields: fields as Parameters<Version2Client['issues']['createIssue']>[0]['fields'],
    });

    return {
      key: created.key,
      id: created.id,
      self: created.self,
    };
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.client.issueComments.addComment({ issueIdOrKey: issueKey, comment: body });
  }

  private escapeJql(value: string): string {
    // eslint-disable-next-line no-control-regex
    return value
      .replace(/[\u0000-\u001F\u007F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .replace(/[[\]{}()*+?.\\^$|]/g, '\\$&')
      .replace(/[\\"]/g, '\\$&');
  }
}
