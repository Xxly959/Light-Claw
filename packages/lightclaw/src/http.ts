import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";

/** Keep fetch and its HTTP/2 dispatcher on the same Undici implementation. */
export function initializeHttpTransport(): EnvHttpProxyAgent {
	install();
	const dispatcher = new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 });
	setGlobalDispatcher(dispatcher);
	return dispatcher;
}
