// Minimal HTTP/1.1 server over react-native-tcp-socket. The ESP32 uses one
// request per connection (Connection: close), so each socket is: accumulate
// bytes -> parse headers (at \r\n\r\n) -> wait for Content-Length body ->
// route -> respond -> close. No pipelining, no chunked encoding.

import TcpSocket from "react-native-tcp-socket";
import { Buffer } from "buffer";

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface HttpResponse {
  status: number;
  json?: unknown;
  raw?: Uint8Array;
  contentType?: string;
}

export type HttpHandler = (req: HttpRequest) => Promise<HttpResponse>;

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  405: "Method Not Allowed",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

const latin1 = (u8: Uint8Array, start: number, end: number): string => {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
  return s;
};

function toBytes(data: Buffer | Uint8Array | string): Uint8Array {
  if (typeof data === "string") {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff;
    return out;
  }
  // Buffer is a Uint8Array subclass — copy the exact view (never the pool)
  return new Uint8Array(
    data.buffer as ArrayBuffer,
    (data as Uint8Array).byteOffset,
    (data as Uint8Array).length
  );
}

function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return i + 4;
    }
  }
  return -1;
}

async function handleSocket(
  socket: any,
  handler: HttpHandler,
  onLog: (line: string) => void
): Promise<void> {
  let acc = new Uint8Array(0);
  let responded = false;

  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(acc.length + chunk.length);
    next.set(acc, 0);
    next.set(chunk, acc.length);
    acc = next;
  };

  const tryServe = async (): Promise<boolean> => {
    if (responded) return true;
    const hEnd = findHeaderEnd(acc);
    if (hEnd < 0) {
      if (acc.length > 16384) throw new Error("headers too large");
      return false; // need more data
    }
    const head = latin1(acc, 0, hEnd);
    const lines = head.split("\r\n");
    const [methodRaw, targetRaw] = lines[0].split(" ");
    const method = (methodRaw || "").toUpperCase();
    const headers: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(":");
      if (idx > 0) {
        headers[lines[i].slice(0, idx).trim().toLowerCase()] =
          lines[i].slice(idx + 1).trim();
      }
    }
    const contentLength = parseInt(headers["content-length"] || "0", 10) || 0;
    if (contentLength > 4 * 1024 * 1024) throw new Error("body too large");
    if (acc.length - hEnd < contentLength) return false; // need more data

    const body = acc.slice(hEnd, hEnd + contentLength);
    const qIdx = targetRaw.indexOf("?");
    const path = qIdx >= 0 ? targetRaw.slice(0, qIdx) : targetRaw;
    const query: Record<string, string> = {};
    if (qIdx >= 0) {
      for (const pair of targetRaw.slice(qIdx + 1).split("&")) {
        const [k, v] = pair.split("=");
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || "");
      }
    }
    responded = true;
    const t0 = Date.now();
    let res: HttpResponse;
    try {
      res = await handler({ method, path, query, headers, body });
    } catch (e) {
      onLog(`[HTTP] handler error: ${(e as Error)?.message || e}`);
      res = { status: 500, json: { error: "Internal server error" } };
    }
    const payload: Uint8Array =
      res.raw ??
      new TextEncoder().encode(JSON.stringify(res.json ?? {}));
    const headOut =
      `HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status] || "OK"}\r\n` +
      `Content-Type: ${res.contentType || "application/json"}\r\n` +
      `Content-Length: ${payload.length}\r\n` +
      `Connection: close\r\n\r\n`;
    const headBytes = new TextEncoder().encode(headOut);
    const out = new Uint8Array(headBytes.length + payload.length);
    out.set(headBytes, 0);
    out.set(payload, headBytes.length);
    socket.write(out);
    onLog(`[HTTP] ${method} ${path} -> ${res.status} (${Date.now() - t0}ms)`);
    socket.end();
    return true;
  };

  socket.on("data", (data: any) => {
    try {
      append(toBytes(data as Buffer | Uint8Array | string));
      void tryServe().catch((e) => {
        onLog(`[HTTP] serve error: ${(e as Error)?.message || e}`);
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
    } catch (e) {
      onLog(`[HTTP] parse error: ${(e as Error)?.message || e}`);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  });
  socket.on("error", () => {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  });
}

export interface RunningServer {
  stop: () => void;
}

export function startHttpServer(
  port: number,
  handler: HttpHandler,
  onLog: (line: string) => void,
  onError: (msg: string) => void
): RunningServer {
  const server = TcpSocket.createServer((socket: any) => {
    void handleSocket(socket, handler, onLog);
  }).listen({ port, host: "0.0.0.0" });
  server.on("error", (err: any) => {
    onError(`Server error: ${(err as Error)?.message || err}`);
  });
  onLog(`[HTTP] listening on 0.0.0.0:${port}`);
  return {
    stop: () => {
      try {
        server.close();
      } catch {
        // ignore
      }
      onLog("[HTTP] stopped");
    },
  };
}
