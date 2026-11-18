/**
 * SMTP bridge.
 *
 * The app runs on an edge runtime that cannot open raw SMTP sockets, so real
 * SMTP delivery is performed by the same local/VPS worker that already powers
 * the OSINT render pipeline. The worker exposes:
 *
 *   POST /smtp/test  { host, port, security, username, password, from_email }
 *   POST /smtp/send  { ...same..., to, subject, html, text, from_name, reply_to }
 *
 * Both endpoints answer `{ ok: boolean, message: string }`.
 */

export type SmtpConfig = {
  host: string;
  port: number;
  security: "ssl" | "starttls" | "none";
  username: string | null;
  password: string | null;
  from_email: string;
  from_name: string | null;
  reply_to: string | null;
  worker_url: string | null;
  worker_secret: string | null;
};

export type SmtpResult = { ok: boolean; message: string };

/** Builds the SMTP config from the saved user settings row. */
export function smtpConfigFrom(row: Record<string, unknown> | null | undefined): {
  config: SmtpConfig | null;
  problem: string | null;
} {
  const s = (row ?? {}) as Record<string, any>;
  const host = (s["smtp_host"] ?? "").toString().trim();
  const domain = (s["email_sender_domain"] ?? "").toString().trim();
  const local = (s["email_from_local"] ?? "").toString().trim();
  const fromEmail =
    (s["smtp_from_email"] ?? "").toString().trim() || (domain && local ? `${local}@${domain}` : "");

  if (!host) return { config: null, problem: "No SMTP host configured. Add one in API Settings → Email sending." };
  if (!fromEmail)
    return {
      config: null,
      problem: "No sender address configured. Set the sender domain and address in API Settings → Email sending.",
    };

  const security = ["ssl", "starttls", "none"].includes(String(s["smtp_secure"]))
    ? (String(s["smtp_secure"]) as SmtpConfig["security"])
    : "starttls";

  return {
    config: {
      host,
      port: Number(s["smtp_port"] ?? (security === "ssl" ? 465 : 587)) || 587,
      security,
      username: (s["smtp_user"] ?? null) as string | null,
      password: (s["smtp_password"] ?? null) as string | null,
      from_email: fromEmail,
      from_name: (s["email_sender_name"] ?? null) as string | null,
      reply_to: (s["email_reply_to"] ?? null) as string | null,
      worker_url: ((s["osint_worker_url"] ?? "") as string).replace(/\/$/, "") || null,
      worker_secret: (s["osint_worker_secret"] ?? null) as string | null,
    },
    problem: null,
  };
}

async function callWorker(config: SmtpConfig, path: string, payload: Record<string, unknown>, timeoutMs: number) {
  if (!config.worker_url) {
    return {
      ok: false,
      message:
        "No worker URL configured. Email delivery runs through your OSINT worker — set its URL in API Settings first.",
    } satisfies SmtpResult;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.worker_url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "ngrok-skip-browser-warning": "true",
        "user-agent": "RECYC-OSINT/1.0",
        ...(config.worker_secret ? { "x-worker-secret": config.worker_secret } : {}),
      },
      body: JSON.stringify({
        host: config.host,
        port: config.port,
        security: config.security,
        username: config.username,
        password: config.password,
        from_email: config.from_email,
        from_name: config.from_name,
        reply_to: config.reply_to,
        ...payload,
      }),
      signal: ctrl.signal,
    });
    if (res.status === 404) {
      return {
        ok: false,
        message:
          "Your worker is reachable but has no email endpoints yet. Update osint-worker/main.py to the version that includes /smtp/test and /smtp/send, then restart it.",
      } satisfies SmtpResult;
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Worker rejected the secret (${res.status}).` } satisfies SmtpResult;
    }
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    if (!res.ok) {
      return { ok: false, message: json?.message || json?.detail || `Worker responded ${res.status}.` } satisfies SmtpResult;
    }
    return { ok: Boolean(json.ok), message: String(json.message ?? (json.ok ? "OK" : "Unknown worker reply")) };
  } catch (e) {
    return { ok: false, message: `Could not reach the worker: ${(e as Error).message}` } satisfies SmtpResult;
  } finally {
    clearTimeout(timer);
  }
}

export function testSmtpConnection(config: SmtpConfig): Promise<SmtpResult> {
  return callWorker(config, "/smtp/test", {}, 45_000);
}

export function sendSmtpMessage(
  config: SmtpConfig,
  message: { to: string; subject: string; html: string; text: string },
): Promise<SmtpResult> {
  return callWorker(config, "/smtp/send", message, 60_000);
}
