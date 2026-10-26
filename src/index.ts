// Client for the saci.cc API: create temporary inboxes and wait for emails, verification
// codes and links. No dependencies; needs a global fetch (Node 18+, Deno, Bun, browsers).

export const DEFAULT_BASE_URL = "https://saci.cc/api";

/** The API holds a request open for at most this long while waiting for an email */
const MAX_WAIT_SECONDS = 25;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 3;

export interface EmailSummary {
  messageId: string;
  from: string;
  subject: string;
  receivedAt?: string;
}

export interface Attachment {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  /** Shown inside the email body (e.g. an embedded image) rather than attached */
  inline: boolean;
  /** Redirects to a download link that works for a few minutes */
  url: string;
}

export interface Email extends EmailSummary {
  html: string | null;
  text: string | null;
  /** The verification code found in the subject or body, if any */
  verificationCode: string | null;
  links: string[];
  attachments: Attachment[];
}

export interface SaciOptions {
  /** Defaults to https://saci.cc/api */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface WaitOptions {
  /** Only emails whose sender contains this text (case-insensitive) or matches this pattern */
  from?: string | RegExp;
  /** Only emails whose subject contains this text (case-insensitive) or matches this pattern */
  subject?: string | RegExp;
  /** Only emails received after this moment. Useful when the inbox already has emails. */
  after?: Date | string;
  /** How long to wait, in milliseconds. Defaults to 60 seconds. */
  timeout?: number;
}

export interface WaitForLinkOptions extends WaitOptions {
  /** Only links that contain this text or match this pattern. Without it, the first link. */
  match?: string | RegExp;
}

export class SaciError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SaciError";
  }
}

export class SaciTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaciTimeoutError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const matches = (value: string, filter: string | RegExp | undefined) =>
  filter === undefined ||
  (typeof filter === "string" ? value.toLowerCase().includes(filter.toLowerCase()) : filter.test(value));

const timeOf = (date: string | undefined) => (date ? Date.parse(date) : NaN);

export class Saci {
  readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(options: SaciOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  /** Creates an inbox. Without a name the address is random, which keeps it private. */
  async createInbox(options: { name?: string } = {}): Promise<Inbox> {
    const query = options.name === undefined ? "" : `?name=${encodeURIComponent(options.name)}`;
    const { address } = await this.request<{ address: string }>("POST", `/addresses${query}`);
    return new Inbox(this, address);
  }

  /** An inbox that already exists, e.g. one created in another test step */
  inbox(address: string): Inbox {
    return new Inbox(this, address);
  }

  /** @internal */
  async request<T>(method: "GET" | "POST" | "DELETE", path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(this.baseUrl + path, { method });
      // Over the per-IP rate limit: wait as long as the API asks, then try again
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after") ?? NaN);
        await sleep((Number.isFinite(retryAfter) ? retryAfter : 5) * 1000);
        continue;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new SaciError(`${method} ${path} failed with ${res.status}: ${body?.error ?? res.statusText}`, res.status);
      }
      return (res.status === 204 ? undefined : await res.json()) as T;
    }
  }
}

export class Inbox {
  constructor(
    private readonly saci: Saci,
    readonly address: string,
  ) {}

  private path(suffix = "") {
    return `/addresses/${encodeURIComponent(this.address)}/emails${suffix}`;
  }

  /** The emails in the inbox, newest first */
  async list(): Promise<EmailSummary[]> {
    return (await this.saci.request<{ emails: EmailSummary[] }>("GET", this.path())).emails;
  }

  async get(messageId: string): Promise<Email> {
    return this.saci.request<Email>("GET", this.path(`/${encodeURIComponent(messageId)}`));
  }

  async delete(messageId: string): Promise<void> {
    await this.saci.request<void>("DELETE", this.path(`/${encodeURIComponent(messageId)}`));
  }

  /** Deletes every email in the inbox and returns how many there were */
  async clear(): Promise<number> {
    return (await this.saci.request<{ deleted: number }>("DELETE", this.path())).deleted;
  }

  /** Waits for an email that matches the filters and returns it in full */
  waitForEmail(options: WaitOptions = {}): Promise<Email> {
    return this.waitFor(options, (email) => email, "matching email");
  }

  /** Waits for an email with a verification code and returns the code, e.g. "482913" */
  waitForCode(options: WaitOptions = {}): Promise<string> {
    return this.waitFor(options, (email) => email.verificationCode, "verification code");
  }

  /** Waits for an email with a link (matching `match`, if given) and returns the link */
  waitForLink(options: WaitForLinkOptions = {}): Promise<string> {
    return this.waitFor(
      options,
      (email) => email.links.find((link) => matches(link, options.match)) ?? null,
      options.match === undefined ? "link" : `link matching ${options.match}`,
    );
  }

  // Long-polls the inbox until `pick` finds something in an email that passes the filters.
  // Each email is opened at most once; newer emails are checked first.
  private async waitFor<T>(options: WaitOptions, pick: (email: Email) => T | null, what: string): Promise<T> {
    const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT_MS);
    const after = options.after === undefined ? NaN : new Date(options.after).getTime();
    const checked = new Set<string>();
    // The API returns as soon as there's an email received after `cursor`
    let cursor = Number.isNaN(after) ? undefined : new Date(after).toISOString();

    for (;;) {
      const wait = Math.min(Math.max(Math.ceil((deadline - Date.now()) / 1000), 0), MAX_WAIT_SECONDS);
      const query = new URLSearchParams({ wait: String(wait) });
      if (cursor) query.set("after", cursor);
      const { emails } = await this.saci.request<{ emails: EmailSummary[] }>("GET", this.path(`?${query}`));

      for (const summary of emails) {
        if (checked.has(summary.messageId)) continue;
        checked.add(summary.messageId);
        if (!Number.isNaN(after) && !(timeOf(summary.receivedAt) > after)) continue;
        if (!matches(summary.from, options.from) || !matches(summary.subject, options.subject)) continue;
        const found = pick(await this.get(summary.messageId));
        if (found !== null && found !== undefined) return found;
      }

      const newest = Math.max(...emails.map((e) => timeOf(e.receivedAt)).filter((t) => !Number.isNaN(t)));
      if (Number.isFinite(newest) && (!cursor || newest > Date.parse(cursor))) cursor = new Date(newest).toISOString();

      if (Date.now() >= deadline) {
        throw new SaciTimeoutError(`No ${what} arrived at ${this.address} within ${options.timeout ?? DEFAULT_TIMEOUT_MS} ms`);
      }
    }
  }

  toString(): string {
    return this.address;
  }
}

const defaultClient = new Saci();

/** Creates an inbox on saci.cc. Shortcut for `new Saci().createInbox()`. */
export const createInbox = (options?: { name?: string }) => defaultClient.createInbox(options);
