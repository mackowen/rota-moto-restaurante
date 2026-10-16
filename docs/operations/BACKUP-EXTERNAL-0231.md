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
- Os templates de Termux e Compose montam/declaram o arquivo do cofre externo separadamente da chave dos recovery sets. No Compose, defina no ambiente de interpolação do host `BACKUP_DESTINATION_KEY_FILE` e, no env-file privado do contêiner, `ROTAMOTO_BACKUP_DESTINATION_KEY_FILE=/run/secrets/backup-destinations.key`; o serviço HTTP administrativo que cadastra destinos precisa ler o mesmo cofre/chave sob a política de permissões apropriada.

## Validação segura

Somente dados e credenciais sintéticos foram usados. `tests/test-backup-storage-providers.js` usa serviço HTTP S3 compatível e servidor `sshd` descartável em loopback; verifica SigV4, upload, HEAD/hash, remoção do probe sintético, host key pinada, transferência repetida e manifesto publicado por último. `npm run test:backup-center` e `npm test` cobrem regressões locais. A captura `evidence-0231/backup-destinations-mobile.png` e o runner CDP estão em `~/projetos/browser-tests`, fora do repositório de produção.

Nenhuma conta de nuvem, host externo, PostgreSQL oficial, backup real, chave real, serviço global, restore operacional ou push dos aplicativos foi usado.

## Complemento 0233-A — leitura, reconciliação e recuperação remota

O executor agora publica, lista por paginação, baixa para staging privado e verifica objetos S3; a publicação inclui SigV4, SHA-256 dos componentes e manifesto por último. Para SFTP, OpenSSH exige a host key previamente fixada, lista e baixa recovery sets, verifica tamanho/hash, publica por diretório staging e rename, rejeita symlinks encontrados no conjunto remoto e remove componentes antes do manifesto. Novos downloads criam também o diretório de mídia privado vazio quando o conjunto não contém mídia. A aplicação verifica depois o HMAC, a cifra, o ledger e todos os componentes com `verifyRecoverySet` antes de qualquer restore.

O inventário autenticado junta conjuntos locais e remotos. A retenção verifica os conjuntos remotos, preserva no mínimo `minimumCopies` conjuntos íntegros mais recentes e só exclui os que excederam a retenção; conteúdo incompleto ou não autenticado não é elegível. O backup local continua válido quando um destino falha e a retenção local só roda depois de o fluxo configurado terminar com sucesso. Jobs mantêm fila durável, lock e estados incertos após crash; retries de rede S3 e de sessões SFTP são limitados, e os nomes de recovery set determinísticos permitem reconciliação/replay sem publicar manifesto incompleto.

Restore remoto mantém o `destinationId` na solicitação e na aprovação independente. A API exige administrador, CSRF e MFA recente na solicitação e em quem aprova; o solicitante não pode aprovar a própria solicitação. O executor baixa e verifica o recovery set, preflight e restore exclusivamente no alvo `rotamoto_disposable_*`, e valida ledger, schema, constraints, indexes e RLS antes de marcar sucesso. A tela mostra estado do destino e última verificação sem expor credenciais ou paths de servidor.

Validações de Campanha 0233-A: `npm test` (Restaurante), `npm test` (Motoboy), `npm run test:backup-center`, `npm run test:backup-disposable-postgres` e Browser/CDP autenticado. O S3 usou um fixture HTTP loopback que aceita somente requests SigV4 assinados; o teste passou paginação, upload/download, corrupção, credenciais inválidas, falha de rede, timeout/retry, TLS autofirmado rejeitado e proteção de retenção. O SFTP usou `sshd`/SFTP OpenSSH real em loopback e exercitou chave fixada/errada, replay, listagem, download e remoção; não foi usado serviço ou dado externo. O ensaio PostgreSQL capturou um cluster efêmero, transferiu os objetos S3, autenticou o recovery set baixado e restaurou um registro sintético em database descartável. O Browser/CDP usou APIs reais e sessão MFA sintética: configurou agenda, enfileirou backup manual/automático, verificou replay, aprovou restore por segundo administrador e conferiu o restore descartável. A jornada de Browser foi local; transferência remota + restore foi comprovada pelo teste integrado de protocolo/PostgreSQL, não por uma única jornada Browser com destino remoto configurado.

Evidências sanitizadas: `~/projetos/browser-tests/evidencias/campanhas/0233-A/backup-center/` (screenshots desktop/mobile, logs e gate Browser) e `remote-postgres-recovery.json` (request count e integridade, sem chaves). O fixture HTTP prova compatibilidade do protocolo na execução local; não equivale à homologação de provedor S3/SFTP real. Linux/systemd e Docker/Podman continuam pendentes por ausência desses ambientes no Termux. Nenhum acesso ao database oficial foi feito. Para um backup autorizado em implantação, `ROTAMOTO_BACKUP_OPERATIONAL_SOURCE_ENABLED=true` é obrigatório fora de test mode e aceita somente o nome `rotamoto` com role dedicada `rotamoto_backup`; não habilita restore operacional.
