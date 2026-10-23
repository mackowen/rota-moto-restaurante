# Gates — campanha 0304 (checkpoint atual)

| Gate | Estado | Evidência/limite |
|---|---|---|
| G0 — Referências | PASS | Três referências abertas, medidas, identificadas e SHA-256 registrados. |
| G1 — Auditoria | PARTIAL | Contratos e serviços centrais inventariados; testes operacionais e conflitos não executados. |
| G2 — Design System | PARTIAL | Tokens/regras V2 reaproveitados; fidelidade visual comparativa Rotas pendente. |
| G3 — Celular | PARTIAL | Layout mapa-primeiro implementado; Browser autêntico pós-change bloqueado. |
| G4 — Tablet | PARTIAL | Grid dedicado 600–1023px; referência verificada, render final não comparado. |
| G5 — PC | PARTIAL | Lista/mapa/detalhe em painéis; render final não comparado. |
| G6 — Mapa/cartografia | PARTIAL | Leaflet e serviços existentes preservados; geocode tácito removido; falha/resize/tiles E2E pendentes. |
| G7 — Planejamento | PARTIAL | UI reutiliza regras/persistência existentes; sequência e save Browser não testados. |
| G8 — Persistência | BLOCKED | Login 403 impediu confirmação em UI/reload. |
| G9 — Integração | PARTIAL | Contratos e responsabilidades preservados; jornada cross-app não executada. |
| G10 — Sync/concorrência | BLOCKED | Sem sessão E2E Browser válida para cenários; tentativas anteriores foram interrompidas/falharam. |
| G11 — Segurança/RBAC | PARTIAL | Validadores atuais preservados; tenant adversarial/RBAC de rotas não testados. |
| G12 — Offline/resiliência | PARTIAL | Não foi demonstrada confirmação remota falsa; falhas/reconexão ainda não testadas nesta UI. |
| G13 — E2E | FAIL | Suite Browser tentada, mas não concluiu por falha de harness/autenticação; testes unitários não substituem E2E. |
| G14 — Fidelidade visual | TECHNICAL_PASS / PENDING_USER_APPROVAL (parcial) | Layouts estruturais implementados; comparação pós-change completa não disponível; aprovação pertence ao proprietário. |
| G15 — Sem regressões | PARTIAL | Testes direcionados de mapas/logística/contrato passaram; regression Browser Início/Pedidos/Motoboys autenticado bloqueado. |

Não há PASS global. A tela de login e render isolado do renderer não são aceites como comparação final de aplicação.
