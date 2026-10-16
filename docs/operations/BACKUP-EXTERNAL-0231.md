# Armazenamento externo de backup — Campanha 0231

## Implementado

- O executor reutiliza recovery sets criptografados/verificados e aceita políticas com destinos principal/secundário e retenção por destino.
- O provedor S3 usa SigV4 e endpoints HTTPS compatíveis. O teste unitário simula upload, HEAD/hash e manifesto publicado por último.
- O provedor SFTP invoca OpenSSH sem shell, exige `StrictHostKeyChecking=yes`, arquivo `known_hosts` privado e fingerprint SHA256 conferido contra a chave configurada. Publica em staging, verifica download/hash dos objetos e move o conjunto ao final.
- O catálogo de destinos fica cifrado em AES-256-GCM usando `ROTAMOTO_BACKUP_DESTINATION_KEY_FILE`, separado da chave dos artefatos; a API lista somente campos públicos. CRUD exige a allowlist administrativa, MFA recente e CSRF, e as ações passam pela auditoria existente.
- A central permite cadastrar, editar, testar, desativar, selecionar política e ajustar retenção. O formulário nunca preenche nem devolve segredos existentes.

## Limites desta entrega

Estado da campanha: **PARTIAL**. Não cadastre destinos reais antes de completar os itens abaixo.

- O teste S3 faz PUT/HEAD/DELETE de um objeto aleatório de prova e verifica hash/tamanho; em um destino real, esse botão exige MFA e remove apenas a chave aleatória criada pela própria prova. A integração foi executada somente contra um serviço HTTP S3 simulado local; nenhuma conta real foi usada.
- Não há inventário, download/restore ou remoção remota para S3/SFTP. O restore existente continua aceitando somente recovery sets locais; não há restore operacional nesta campanha.
- `retentionDays` e `minimumCopies` são armazenados/validados, mas a poda remota, consulta de capacidade e proteção de exclusão da última cópia recuperável ainda precisam ser implementadas antes de habilitar exclusões remotas.
- Falhas deixam o manifesto ausente até a publicação. PUTs são idempotentes para o mesmo ID no S3; o SFTP usa staging determinístico e a publicação repetida do mesmo conjunto foi exercitada, mas ainda não há registro durável de retomada por arquivo nem injeção de corte de rede durante o envio.
- Foi iniciado um `sshd` descartável em loopback, com chaves e dados sintéticos, e exercitado o upload/download/hash/publicação SFTP sem root. A UI do Browser foi validada com sessão e APIs sintéticas.
- Provisionar uma chave aleatória de 32 bytes para `ROTAMOTO_BACKUP_DESTINATION_KEY_FILE`. Em Linux com UIDs separados, usar arquivo `root:<grupo-control>` modo `0640` e garantir que os dois processos pertençam ao grupo privado; o cofre rejeita permissões de acesso para outros. Em Termux, manter modo `0600` e UID do app. A chave é distinta de `ROTAMOTO_BACKUP_KEY_FILE`.

## Validação segura

Somente dados e credenciais sintéticos foram usados. `tests/test-backup-storage-providers.js` usa serviço HTTP S3 compatível e servidor `sshd` descartável em loopback; verifica SigV4, upload, HEAD/hash, remoção do probe sintético, host key pinada, transferência repetida e manifesto publicado por último. `npm run test:backup-center` e `npm test` cobrem regressões locais. A captura `evidence-0231/backup-destinations-mobile.png` e o runner CDP estão em `~/projetos/browser-tests`, fora do repositório de produção.

Nenhuma conta de nuvem, host externo, PostgreSQL oficial, backup real, chave real, serviço global, restore operacional ou push dos aplicativos foi usado.
