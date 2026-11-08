/**
 * OpenList Proxy - Cloudflare Workers + EdgeOne Makers
 * Modified by haoges on 2026-11-08; based on OpenListTeam/OpenList-Proxy.
 * This program is free software under GNU GPL v3. See LICENSE.
 *
 * Required environment: ADDRESS, TOKEN (TOKEN should be a secret).
 * Optional: WORKER_ADDRESS, DISABLE_SIGN, CORS_ORIGINS,
 * REQUEST_TIMEOUT_MS (default 30000), MAX_REDIRECTS (default 8).
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_REDIRECTS = 8;
const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

function getConfig(env = {}, request) {
  const address = String(env.ADDRESS || "").trim().replace(/\/+$/, "");
  const token = String(env.TOKEN || "").trim();
  const workerAddress = String(env.WORKER_ADDRESS || new URL(request.url).origin).trim().replace(/\/+$/, "");
  let originUrl, workerUrl;
  try {
    originUrl = new URL(address);
    workerUrl = new URL(workerAddress);
  } catch {
    throw new Error("Invalid ADDRESS or WORKER_ADDRESS");
  }
  if (!["http:", "https:"].includes(originUrl.protocol)) throw new Error("ADDRESS must use http or https");
  if (!["http:", "https:"].includes(workerUrl.protocol)) throw new Error("WORKER_ADDRESS must use http or https");
  if (!token) throw new Error("TOKEN is required");

  const timeout = Number.parseInt(env.REQUEST_TIMEOUT_MS, 10);
  const redirects = Number.parseInt(env.MAX_REDIRECTS, 10);
  return {
    address, token, workerAddress, workerOrigin: workerUrl.origin,
    disableSign: env.DISABLE_SIGN === true || String(env.DISABLE_SIGN).toLowerCase() === "true",
    corsOrigins: String(env.CORS_ORIGINS || "*").split(",").map(v => v.trim()).filter(Boolean),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 120000) : DEFAULT_TIMEOUT_MS,
    maxRedirects: Number.isFinite(redirects) && redirects >= 0 ? Math.min(redirects, 15) : DEFAULT_MAX_REDIRECTS,
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: h });
}

function corsOrigin(request, config) {
  const origin = request.headers.get("Origin");
  if (!origin) return "*";
  if (config.corsOrigins.includes("*")) return "*";
  return config.corsOrigins.includes(origin) ? origin : null;
}

function applyCors(headers, origin) {
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified");
  headers.append("Vary", "Origin");
  return headers;
}

function handleOptions(request, config) {
  const origin = corsOrigin(request, config);
  if (origin === null) return jsonResponse({ code: 403, message: "Origin not allowed" }, 403);
  const requestedMethod = request.headers.get("Access-Control-Request-Method");
  if (requestedMethod && !["GET", "HEAD"].includes(requestedMethod.toUpperCase())) {
    return jsonResponse({ code: 405, message: "Method not allowed" }, 405, applyCors(new Headers(), origin));
  }
  const headers = applyCors(new Headers(), origin);
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
  if (requestedHeaders) headers.set("Access-Control-Allow-Headers", requestedHeaders);
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, { status: 204, headers });
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifySignature(path, sign, token) {
  if (!sign) return "signature missing";
  const separator = sign.lastIndexOf(":");
  if (separator <= 0) return "signature format invalid";
  const signatureText = sign.slice(0, separator);
  const expireText = sign.slice(separator + 1);
  if (!/^(0|[1-9]\d*)$/.test(expireText)) return "expire invalid";
  const expire = Number(expireText);
  if (!Number.isSafeInteger(expire)) return "expire invalid";
  if (expire > 0 && expire <= Math.floor(Date.now() / 1000)) return "expire expired";
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlToBytes(signatureText),
      new TextEncoder().encode(\`${path}:${expire}\`));
    return valid ? "" : "sign mismatch";
  } catch {
    return "signature invalid";
  }
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("Upstream request timeout"), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchWithTimeout(resource, init, timeoutMs) {
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    return await fetch(resource, { ...init, signal: timeout.signal });
  } finally {
    timeout.clear();
  }
}

function buildDownloadHeaders(clientRequest, linkHeaders) {
  const headers = new Headers();
  // Forward download-related headers only; never leak client cookies or credentials.
  for (const name of ["Range", "If-Range", "If-None-Match", "If-Modified-Since", "Accept", "Accept-Encoding", "User-Agent"]) {
    const value = clientRequest.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (linkHeaders && typeof linkHeaders === "object") {
    for (const [name, rawValues] of Object.entries(linkHeaders)) {
      for (const value of (Array.isArray(rawValues) ? rawValues : [rawValues])) {
        if (value !== undefined && value !== null) {
          try { headers.append(name, String(value)); } catch { /* Ignore invalid provider headers. */ }
        }
      }
    }
  }
  return headers;
}

function normalizePath(pathname) {
  let path;
  try { path = decodeURIComponent(pathname); }
  catch { throw new Error("Invalid URL encoding in path"); }
  if (path.includes("\0")) throw new Error("Invalid path");
  return path;
}

async function handleDownload(request, config, redirectDepth = 0) {
  const requestUrl = new URL(request.url);
  const origin = corsOrigin(request, config);
  if (origin === null) return jsonResponse({ code: 403, message: "Origin not allowed" }, 403);

  let path;
  try { path = normalizePath(requestUrl.pathname); }
  catch (error) { return jsonResponse({ code: 400, message: error.message }, 400, applyCors(new Headers(), origin)); }

  if (!config.disableSign) {
    const reason = await verifySignature(path, requestUrl.searchParams.get("sign") || "", config.token);
    if (reason) return jsonResponse({ code: 401, message: reason }, 401, applyCors(new Headers(), origin));
  }

  let apiResponse;
  try {
    apiResponse = await fetchWithTimeout(\`${config.address}/api/fs/link\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: config.token },
      body: JSON.stringify({ path }),
    }, config.timeoutMs);
  } catch (error) {
    return jsonResponse({ code: 502, message: error?.name === "AbortError" ? "OpenList API timeout" : "Unable to connect to OpenList API" }, 502, applyCors(new Headers(), origin));
  }

  let linkResult;
  try { linkResult = await apiResponse.json(); }
  catch { return jsonResponse({ code: 502, message: "Invalid response from OpenList API" }, 502, applyCors(new Headers(), origin)); }

  if (!apiResponse.ok || !linkResult || linkResult.code !== 200 || !linkResult.data?.url) {
    const status = apiResponse.status >= 400 && apiResponse.status <= 599 ? apiResponse.status : 502;
    return jsonResponse(linkResult || { code: 502, message: "OpenList did not return a download URL" }, status, applyCors(new Headers(), origin));
  }

  let downloadUrl;
  try {
    downloadUrl = new URL(linkResult.data.url);
    if (!["http:", "https:"].includes(downloadUrl.protocol)) throw new Error("Unsupported protocol");
  } catch {
    return jsonResponse({ code: 502, message: "OpenList returned an invalid download URL" }, 502, applyCors(new Headers(), origin));
  }

  if (redirectDepth > config.maxRedirects) return jsonResponse({ code: 508, message: "Too many redirects" }, 508, applyCors(new Headers(), origin));
  const downloadHeaders = buildDownloadHeaders(request, linkResult.data.header);
  let downloadResponse;
  try {
    downloadResponse = await fetchWithTimeout(downloadUrl.toString(), {
      method: request.method, headers: downloadHeaders, redirect: "manual",
    }, config.timeoutMs);
  } catch (error) {
    return jsonResponse({ code: 502, message: error?.name === "AbortError" ? "Download source timeout" : "Unable to connect to download source" }, 502, applyCors(new Headers(), origin));
  }

  if (downloadResponse.status >= 300 && downloadResponse.status < 400) {
    const location = downloadResponse.headers.get("Location");
    if (location) {
      let nextUrl;
      try { nextUrl = new URL(location, downloadUrl); }
      catch { return jsonResponse({ code: 502, message: "Invalid redirect URL" }, 502, applyCors(new Headers(), origin)); }
      if (!["http:", "https:"].includes(nextUrl.protocol)) {
        return jsonResponse({ code: 502, message: "Unsupported redirect protocol" }, 502, applyCors(new Headers(), origin));
      }
      if (nextUrl.origin === config.workerOrigin) {
        if (redirectDepth >= config.maxRedirects) return jsonResponse({ code: 508, message: "Too many redirects" }, 508, applyCors(new Headers(), origin));
        return handleDownload(new Request(nextUrl.toString(), request), config, redirectDepth + 1);
      }
      if (nextUrl.origin !== downloadUrl.origin) {
        downloadHeaders.delete("Authorization");
        downloadHeaders.delete("Cookie");
        downloadHeaders.delete("Proxy-Authorization");
      }
      if (redirectDepth >= config.maxRedirects) return jsonResponse({ code: 508, message: "Too many redirects" }, 508, applyCors(new Headers(), origin));
      try {
        downloadResponse = await fetchWithTimeout(nextUrl.toString(), {
          method: request.method, headers: downloadHeaders, redirect: "follow",
        }, config.timeoutMs);
      } catch {
        return jsonResponse({ code: 502, message: "Redirect target request failed" }, 502, applyCors(new Headers(), origin));
      }
    }
  }

  const responseHeaders = new Headers(downloadResponse.headers);
  responseHeaders.delete("Set-Cookie");
  responseHeaders.delete("Alt-Svc");
  applyCors(responseHeaders, origin);
  // Keep the body streaming; large files are never buffered in memory.
  return new Response(request.method === "HEAD" ? null : downloadResponse.body, {
    status: downloadResponse.status, statusText: downloadResponse.statusText, headers: responseHeaders,
  });
}

async function handleRequest(request, env = {}) {
  let config;
  try { config = getConfig(env, request); }
  catch (error) { return jsonResponse({ code: 500, message: error.message }, 500); }

  if (request.method === "OPTIONS") return handleOptions(request, config);
  const url = new URL(request.url);
  if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
    return jsonResponse({ code: 200, message: "OpenList Proxy is running", platform: "Cloudflare Workers / EdgeOne Makers" });
  }
  if (!["GET", "HEAD"].includes(request.method)) {
    return jsonResponse({ code: 405, message: "Method not allowed" }, 405, { Allow: ALLOWED_METHODS });
  }
  return handleDownload(request, config);
}

const worker = {
  async fetch(request, env, ctx) {
    try { return await handleRequest(request, env || {}); }
    catch { return jsonResponse({ code: 500, message: "Internal proxy error" }, 500); }
  },
};

export { handleRequest };
export default worker;
