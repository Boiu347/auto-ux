import { createServer } from "node:http";

import next from "next";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.AUTO_UX_HOST ?? "0.0.0.0";
const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const basePath = configuredBasePath
  ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
  : "";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

createServer((request, response) => {
  const requestUrl = request.url ?? "/";
  if (
    basePath &&
    requestUrl !== basePath &&
    !requestUrl.startsWith(`${basePath}/`) &&
    !requestUrl.startsWith(`${basePath}?`)
  ) {
    request.url = `${basePath}${requestUrl.startsWith("/") ? "" : "/"}${requestUrl}`;
  }
  void handle(request, response);
}).listen(port, hostname, () => {
  console.log(`auto UX listening on http://${hostname}:${port}${basePath || "/"}`);
});
