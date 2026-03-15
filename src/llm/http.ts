import { Agent, ProxyAgent, type Dispatcher } from "undici";

// Respect standard proxy environment variables for provider network calls.
export function buildProviderDispatcher(): Dispatcher {
  const proxyUrl =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;

  const connectOptions = { timeout: 30_000 };

  if (proxyUrl) {
    return new ProxyAgent({ uri: proxyUrl, connect: connectOptions });
  }

  return new Agent({ connect: connectOptions });
}
