import { createHash } from "node:crypto";
import { env } from "../lib/env";

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g;

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook("render:response", (_response, { event }) => {
    setResponseHeaders(event, {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      ...(env.AUTH_BASE_URL.startsWith("https://")
        ? { "strict-transport-security": "max-age=31536000; includeSubDomains" }
        : {}),
    });
  });

  if (import.meta.dev) return;

  nitro.hooks.hook("render:html", (html, { event }) => {
    const markup = [...html.head, ...html.bodyPrepend, ...html.body, ...html.bodyAppend].join("\n");
    const hashes = [...markup.matchAll(INLINE_SCRIPT)].map(
      (m) =>
        `'sha256-${createHash("sha256")
          .update(m[1] ?? "")
          .digest("base64")}'`,
    );

    setResponseHeader(
      event,
      "content-security-policy",
      [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(" ")}`.trim(),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        `form-action 'self' ${env.DATAHUB_URL} ${env.AGO_URL}`,
      ].join("; "),
    );
  });
});
