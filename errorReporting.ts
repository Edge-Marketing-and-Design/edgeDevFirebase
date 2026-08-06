import type { App, ComponentPublicInstance } from "vue";

const DEFAULT_MONITOR_URL = "https://ingest.monitor.edgemarketingdesign.com";
const MAX_EVENTS_PER_PAGE = 20;
const MAX_WARNINGS_PER_PAGE = 5;
const MAX_BATCH_SIZE = 10;
const FLUSH_DELAY_MS = 1500;

type BrowserErrorType =
  | "error"
  | "unhandledrejection"
  | "resource"
  | "console_error"
  | "console_warn";

interface BrowserErrorEvent {
  type: BrowserErrorType;
  message: string;
  stack?: string;
  pageUrl: string;
  sourceUrl?: string;
  line?: number;
  column?: number;
  occurredAt: string;
  sessionId: string;
}

interface BrowserInstallation {
  token: string;
  expiresAt: number;
  ingestUrl: string;
}

export interface EdgeErrorReportingOptions {
  enabled?: boolean;
  monitorUrl?: string;
  captureConsoleWarnings?: boolean;
}

interface ReporterOptions extends EdgeErrorReportingOptions {
  projectId: string;
}

const reporters = new Map<string, BrowserErrorReporter>();

export function getBrowserErrorReporter(options: ReporterOptions) {
  if (typeof window === "undefined" || options.enabled !== true || !options.projectId)
    return null;

  const current = reporters.get(options.projectId);
  if (current)
    return current;

  const reporter = new BrowserErrorReporter(options);
  reporters.set(options.projectId, reporter);
  reporter.start();
  return reporter;
}

export class BrowserErrorReporter {
  private readonly projectId: string;
  private readonly monitorUrl: string;
  private readonly captureConsoleWarnings: boolean;
  private readonly sessionId: string;
  private readonly events: BrowserErrorEvent[] = [];
  private readonly fingerprints = new Set<string>();
  private readonly reportedErrors = new WeakSet<object>();
  private installation: BrowserInstallation | null = null;
  private warningCount = 0;
  private flushTimer: number | null = null;
  private installTimer: number | null = null;
  private installAttempts = 0;
  private started = false;

  constructor(options: ReporterOptions) {
    this.projectId = options.projectId;
    this.monitorUrl = (options.monitorUrl || DEFAULT_MONITOR_URL).replace(/\/$/, "");
    this.captureConsoleWarnings = options.captureConsoleWarnings !== false;
    this.sessionId = createSessionId();
  }

  public start() {
    if (this.started)
      return;
    this.started = true;
    window.addEventListener("error", this.handleWindowError, true);
    window.addEventListener("unhandledrejection", this.handleUnhandledRejection);
    window.addEventListener("pagehide", this.handlePageHide);
    this.installConsoleCapture();
    void this.install();
  }

  public attachVueApp(app: App) {
    const existingHandler = app.config.errorHandler;
    app.config.errorHandler = (
      error: unknown,
      instance: ComponentPublicInstance | null,
      info: string,
    ) => {
      this.captureError(error, {
        messagePrefix: info ? `Vue ${info}` : "Vue error",
      });
      if (existingHandler)
        existingHandler(error, instance, info);
    };
  }

  public captureCallableError(functionName: string, error: unknown) {
    this.captureError(error, {
      messagePrefix: `Firebase callable ${functionName} failed`,
    });
  }

  private captureError(error: unknown, context: { messagePrefix?: string } = {}) {
    if (isObject(error)) {
      if (this.reportedErrors.has(error))
        return;
      this.reportedErrors.add(error);
    }
    const normalized = normalizeError(error);
    const message = context.messagePrefix
      ? `${context.messagePrefix}: ${normalized.message}`
      : normalized.message;
    this.enqueue({
      type: "error",
      message: safeText(message, 1200) || "Unknown browser error",
      stack: safeStack(normalized.stack, 8000),
      pageUrl: currentPageUrl(),
      occurredAt: new Date().toISOString(),
      sessionId: this.sessionId,
    });
  }

  private readonly handleWindowError = (event: ErrorEvent) => {
    const target = event.target;
    if (target && target !== window && isResourceElement(target)) {
      const sourceUrl = resourceUrl(target);
      this.enqueue({
        type: "resource",
        message: `Failed to load ${target.tagName.toLowerCase()} resource`,
        pageUrl: currentPageUrl(),
        sourceUrl,
        occurredAt: new Date().toISOString(),
        sessionId: this.sessionId,
      });
      return;
    }
    if (event.error && isObject(event.error)) {
      if (this.reportedErrors.has(event.error))
        return;
      this.reportedErrors.add(event.error);
    }
    const normalized = normalizeError(event.error || event.message);
    this.enqueue({
      type: "error",
      message: safeText(normalized.message, 1200) || "Unknown browser error",
      stack: safeStack(normalized.stack, 8000),
      pageUrl: currentPageUrl(),
      sourceUrl: safeUrl(event.filename),
      line: finiteInteger(event.lineno),
      column: finiteInteger(event.colno),
      occurredAt: new Date().toISOString(),
      sessionId: this.sessionId,
    });
  };

  private readonly handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (isObject(event.reason)) {
      if (this.reportedErrors.has(event.reason))
        return;
      this.reportedErrors.add(event.reason);
    }
    const normalized = normalizeError(event.reason);
    this.enqueue({
      type: "unhandledrejection",
      message: safeText(normalized.message, 1200) || "Unknown browser error",
      stack: safeStack(normalized.stack, 8000),
      pageUrl: currentPageUrl(),
      occurredAt: new Date().toISOString(),
      sessionId: this.sessionId,
    });
  };

  private readonly handlePageHide = () => {
    this.flush(true);
  };

  private installConsoleCapture() {
    const originalError = console.error.bind(console);
    const originalWarn = console.warn.bind(console);
    console.error = (...args: unknown[]) => {
      originalError(...args);
      this.captureConsole("console_error", args);
    };
    console.warn = (...args: unknown[]) => {
      originalWarn(...args);
      if (this.captureConsoleWarnings && this.warningCount < MAX_WARNINGS_PER_PAGE) {
        this.warningCount += 1;
        this.captureConsole("console_warn", args);
      }
    };
  }

  private captureConsole(type: "console_error" | "console_warn", args: unknown[]) {
    const parts = args
      .map(consoleArgument)
      .filter(Boolean)
      .slice(0, 5);
    if (!parts.length)
      return;
    const firstError = args.find(value => value instanceof Error) as Error | undefined;
    this.enqueue({
      type,
      message: safeText(parts.join(" "), 1200) || "Browser console error",
      stack: safeStack(firstError?.stack, 8000),
      pageUrl: currentPageUrl(),
      occurredAt: new Date().toISOString(),
      sessionId: this.sessionId,
    });
  }

  private enqueue(event: BrowserErrorEvent) {
    if (!event.message || this.fingerprints.size >= MAX_EVENTS_PER_PAGE)
      return;
    const fingerprint = [event.type, event.message, event.stack || "", event.sourceUrl || ""]
      .join("|")
      .slice(0, 12_000);
    if (this.fingerprints.has(fingerprint))
      return;
    this.fingerprints.add(fingerprint);
    this.events.push(event);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (!this.installation || this.flushTimer !== null)
      return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flush(false);
    }, FLUSH_DELAY_MS);
  }

  private flush(useBeacon: boolean) {
    if (!this.installation || !this.events.length)
      return;
    if (this.installation.expiresAt <= Math.floor(Date.now() / 1000)) {
      this.installation = null;
      void this.install();
      return;
    }
    const events = this.events.splice(0, MAX_BATCH_SIZE);
    const body = JSON.stringify({ token: this.installation.token, events });
    let sent = false;
    if (useBeacon && typeof navigator.sendBeacon === "function") {
      sent = navigator.sendBeacon(
        this.installation.ingestUrl,
        new Blob([body], { type: "text/plain" }),
      );
    }
    if (!sent) {
      void fetch(this.installation.ingestUrl, {
        method: "POST",
        body,
        headers: { "content-type": "text/plain" },
        credentials: "omit",
        keepalive: true,
      }).catch(() => undefined);
    }
    if (this.events.length)
      this.scheduleFlush();
  }

  private async install() {
    if (this.installation)
      return;
    try {
      const response = await fetch(`${this.monitorUrl}/v1/errors/browser/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ projectId: this.projectId }),
      });
      if (!response.ok)
        throw new Error("Browser error reporting is not registered.");
      const installation = await response.json() as Partial<BrowserInstallation>;
      if (
        typeof installation.token !== "string"
        || typeof installation.ingestUrl !== "string"
        || !Number.isInteger(installation.expiresAt)
      ) {
        throw new Error("Browser error reporting returned an invalid installation.");
      }
      this.installation = installation as BrowserInstallation;
      this.installAttempts = 0;
      this.scheduleFlush();
      const refreshInMs = Math.max(
        60_000,
        (installation.expiresAt * 1000) - Date.now() - (5 * 60_000),
      );
      this.installTimer = window.setTimeout(() => {
        this.installation = null;
        void this.install();
      }, refreshInMs);
    } catch {
      this.scheduleInstallRetry();
    }
  }

  private scheduleInstallRetry() {
    if (this.installTimer !== null)
      window.clearTimeout(this.installTimer);
    const retryDelays = [10_000, 60_000, 5 * 60_000, 15 * 60_000];
    const retryDelay = retryDelays[Math.min(this.installAttempts, retryDelays.length - 1)];
    this.installAttempts += 1;
    this.installTimer = window.setTimeout(() => {
      this.installTimer = null;
      void this.install();
    }, retryDelay);
  }
}

function normalizeError(value: unknown) {
  if (value instanceof Error) {
    return {
      message: value.message || value.name || "Unknown browser error",
      stack: value.stack,
    };
  }
  if (typeof value === "string")
    return { message: value };
  return { message: "Unknown browser error" };
}

function consoleArgument(value: unknown) {
  if (typeof value === "string")
    return safeText(value, 1200);
  if (value instanceof Error)
    return safeText(`${value.name}: ${value.message}`, 1200);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return "";
}

function isObject(value: unknown): value is object {
  return Boolean(value) && typeof value === "object";
}

function isResourceElement(value: EventTarget): value is HTMLElement {
  return value instanceof HTMLElement && ["IMG", "SCRIPT", "LINK", "VIDEO", "AUDIO", "SOURCE"].includes(value.tagName);
}

function resourceUrl(element: HTMLElement) {
  const candidate = element.getAttribute("src") || element.getAttribute("href") || "";
  return safeUrl(candidate);
}

function finiteInteger(value: number) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function currentPageUrl() {
  return safeUrl(window.location.href) || "";
}

function safeUrl(value: string | undefined) {
  if (!value)
    return undefined;
  try {
    const url = new URL(value, window.location.href);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeText(value: string | undefined, maximum: number) {
  if (typeof value !== "string")
    return undefined;
  return redact(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum) || undefined;
}

function safeStack(value: string | undefined, maximum: number) {
  if (typeof value !== "string")
    return undefined;
  return redact(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split(/\r?\n/)
    .map(line => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, maximum) || undefined;
}

function redact(value: string) {
  return value
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(password|passwd|token|api[_-]?key|secret|oobCode|code)=([^\s&]+)/gi, "$1=[redacted]");
}

function createSessionId() {
  if (typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
