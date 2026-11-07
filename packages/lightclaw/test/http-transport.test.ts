import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([
	["br", "h2"],
	["gzip", "h2"],
	["br", "http1"],
	["gzip", "http1"],
])("preserves headers and decodes %s SSE over %s with the production dispatcher", (encoding, protocol) => {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-http2-"));
	const cert = join(root, "cert.pem"),
		key = join(root, "key.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ stdio: "ignore" },
	);
	const script = `
 import {createSecureServer} from "node:http2";
 import {createServer as createHttpsServer} from "node:https";
 import {readFileSync} from "node:fs";
 import {brotliCompressSync,gzipSync} from "node:zlib";
 import {once} from "node:events";
 import {getGlobalDispatcher,setGlobalDispatcher} from "undici";
 import {initializeHttpTransport} from "./src/http.ts";
 import "./src/agent.ts";
 import "./src/feishu.ts";
 const expected='data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}'+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10);
 const compressed=${JSON.stringify(encoding)}==="br"?brotliCompressSync(Buffer.from(expected)):gzipSync(Buffer.from(expected));
 let actualProtocol;
 const createServer=${JSON.stringify(protocol)}==="h2"?createSecureServer:createHttpsServer;
 const server=createServer({key:readFileSync(${JSON.stringify(key)}),cert:readFileSync(${JSON.stringify(cert)}),allowHTTP1:true},(_request,response)=>{actualProtocol=_request.httpVersion;response.writeHead(200,{"content-type":"text/event-stream","content-encoding":${JSON.stringify(encoding)}});response.end(compressed);});
 server.listen(0,"127.0.0.1");await once(server,"listening");
 const previous=getGlobalDispatcher();
 const dispatcher=initializeHttpTransport();
 try{
  const response=await fetch('https://localhost:'+server.address().port+'/');
  const result={node:process.version,protocol:actualProtocol,contentType:response.headers.get('content-type'),bodyMatches:(await response.text())===expected};
  console.log(JSON.stringify(result));
 }finally{await dispatcher.close();setGlobalDispatcher(previous);server.close();await once(server,'close');}
 `;
	try {
		const result = JSON.parse(
			execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				encoding: "utf8",
				timeout: 10000,
				env: {
					...process.env,
					NODE_OPTIONS: "",
					NODE_EXTRA_CA_CERTS: cert,
					HTTP_PROXY: "",
					HTTPS_PROXY: "",
					http_proxy: "",
					https_proxy: "",
					NO_PROXY: "127.0.0.1",
					no_proxy: "127.0.0.1",
				},
			}),
		) as { contentType: string | null; bodyMatches: boolean; protocol: string };
		expect(result.contentType).toBe("text/event-stream");
		expect(result.bodyMatches).toBe(true);
		expect(result.protocol).toBe(protocol === "h2" ? "2.0" : "1.1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
