import { env } from "../lib/env";

const allowedOrigins = [env.DATAHUB_URL, env.AGO_URL];

export default defineEventHandler((event) => {
  if (!event.path.startsWith("/api/")) return;
  const handled = handleCors(event, {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "authorization", "x-org-id"],
  });

  if (handled) return null;
});
