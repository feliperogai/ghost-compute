# ADR 001 — Stack do Control Plane

**Status:** aceito

**Contexto.** `ARCHITECTURE.md` propunha Go + gRPC/mTLS. O dono do produto definiu TypeScript/Node, Fastify, PostgreSQL, Redis, REST e WebSocket.

**Decisão.** Implementar o control plane em `control-plane/` com essa stack.
- Canal Worker ↔ servidor: REST para comandos (idempotentes, validados) + WebSocket para push (ofertas, cancelamentos, revogação).
- Autenticação do Worker: segredo de 256 bits trocado por token HMAC de curta duração. mTLS continua como evolução.
- Redis como índice de fila e barramento pub/sub. Postgres continua como fonte de verdade.

**Consequências.** Um só runtime entre dashboard e API. Sem contrato protobuf por enquanto. Os schemas Zod são o contrato.
