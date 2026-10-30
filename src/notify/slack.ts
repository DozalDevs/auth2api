import { SlackConfig } from "../config";

export interface RequestNotice {
  key: string;
  modelNames: string[];
  minutes: number;
  reason: string;
  /** Where an approver clicks to decide; omitted when the relay's address is not configured. */
  reviewUrl?: string;
}

/** Slack treats & < > as markup, which is how a pasted reason could @-mention the whole channel. */
export function slackEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function lengthText(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

export function requestMessage(n: RequestNotice): string {
  const models = n.modelNames.map((m) => `*${slackEscape(m)}*`).join(", ");
  const reason = slackEscape(n.reason)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const link = n.reviewUrl ? `\n<${n.reviewUrl}|Approve or reject it>` : "";
  return `:key: *${slackEscape(n.key)}* is asking for ${models} for ${lengthText(n.minutes)}.\n${reason}${link}`;
}

/**
 * Tells a Slack channel when someone asks for access. Never throws and never
 * waits for long: a Slack outage must not stop a person from asking.
 */
export class SlackNotifier {
  constructor(
    private readonly cfg: SlackConfig,
    private readonly send: typeof fetch = fetch,
  ) {}

  async requestCreated(n: RequestNotice): Promise<void> {
    try {
      const res = await this.send(
        `${this.cfg["api-base"] ?? "https://slack.com/api"}/chat.postMessage`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${this.cfg["bot-token"]}`,
          },
          body: JSON.stringify({
            channel: this.cfg.channel,
            text: requestMessage(n),
            unfurl_links: false,
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      const body: any = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        console.error(
          `[notify] Slack did not accept the message: ${body?.error ?? `HTTP ${res.status}`}`,
        );
      }
    } catch (err: any) {
      console.error(`[notify] could not reach Slack: ${err?.name ?? "error"}`);
    }
  }
}
