// Which proxies the gateway believes (Fastify trustProxy). Exactly one: the socket peer, Traefik
// (proxy-addr numbers hops from it as 0). req.ip is then the address Traefik saw and appended to
// X-Forwarded-For; anything a client wrote further left in that header is ignored, so a client
// cannot choose the address that sign-in throttling and OAuth limits count against.
export const trustOneHop = (_addr: string, hop: number) => hop === 0;
