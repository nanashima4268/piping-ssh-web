import urlJoin from "url-join";

// Returns true if the URL indicates WebSocket direct-connection mode.
export function isWebSocketUrl(url: string): boolean {
  return /^wss?:\/\//i.test(url ?? "");
}

export function getServerHostCommand({pipingServerUrl, pipingServerHeaders, csPath, scPath, sshServerPort, useChunkedUpload}: {
  pipingServerUrl: string, pipingServerHeaders: Array<[string, string]>, csPath: string, scPath: string, sshServerPort: string | number, useChunkedUpload?: boolean
}): string {
  // WebSocket mode: user connects directly to a websockify server on the SSH host.
  if (isWebSocketUrl(pipingServerUrl)) {
    try {
      const wsPort = new URL(pipingServerUrl).port || (pipingServerUrl.startsWith("wss") ? "443" : "80");
      return `websockify ${wsPort} localhost:${sshServerPort}`;
    } catch {
      return `websockify <ws-port> localhost:${sshServerPort}`;
    }
  }

  const headerOptions = pipingServerHeaders.length === 0
    ? ""
    : " " + pipingServerHeaders.map(([name, value]) => `-H '${name}: ${value}'`).join(" ");
  const csUrl = urlJoin(pipingServerUrl, csPath);
  const scUrl = urlJoin(pipingServerUrl, scPath);

  if (useChunkedUpload) {
    // Safari-compatible: reads sequential chunk POSTs from ${csUrl}/0, ${csUrl}/1, ...
    // An empty (0-byte) chunk signals end-of-stream.
    const chunkedCs = [
      `i=0; while true; do`,
      `tmp=$(mktemp);`,
      `curl -sSN${headerOptions} "${csUrl}/$i" > "$tmp";`,
      `[ ! -s "$tmp" ] && { rm "$tmp"; break; };`,
      `cat "$tmp"; rm "$tmp"; i=$((i+1));`,
      `done`,
    ].join(" ");
    return `${chunkedCs} | nc localhost ${sshServerPort} | curl -sSNT -${headerOptions} ${scUrl}`;
  }

  return [
    `curl -sSN${headerOptions} ${csUrl}`,
    `nc localhost ${sshServerPort}`,
    `curl -sSNT -${headerOptions} ${scUrl}`,
  ].join(" | ");
}
