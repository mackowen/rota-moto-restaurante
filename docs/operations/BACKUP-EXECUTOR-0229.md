# Executor de backup multiplataforma — Campanha 0229

## Componentes compartilhados

O armazenamento de controle persistente, fila de jobs, scheduler, executor, criação/verificação de recovery sets e restore isolado são implementados em módulos Node comuns. O HTTP apenas registra operações predefinidas. O navegador não recebe URLs PostgreSQL, chaves ou credenciais de armazenamento. A inicialização e a política de identidade variam por plataforma em `backend/runtime/backup-platform.js`.

O executor é um processo Node separado, iniciado por `npm run backup:executor`. Ele mantém lease exclusivo e heartbeat no armazenamento de controle. Ao reiniciar, jobs que ficaram `RUNNING` são classificados `UNKNOWN_OUTCOME`; operações de backup não são repetidas automaticamente quando o resultado pode ser incerto. Restore só aceita destino descartável explicitamente configurado e com nome de banco prefixado para a campanha de teste correspondente.

## Termux sem root

O Android do ambiente usa UID de aplicação compartilhado (observado neste teste: UID 10436). Sem root ou um segundo pacote Android isolado, o servidor HTTP e o executor não podem obter UIDs distintos. A implementação exige opt-in explícito:

- `ROTAMOTO_BACKUP_TERMUX_SHARED_UID=enabled`
- `ROTAMOTO_BACKUP_TERMUX_SHARED_UID_RISK_ACK=HTTP_AND_EXECUTOR_SHARE_APP_UID`
- `ROTAMOTO_BACKUP_EXECUTOR_UID` igual ao UID efetivo do processo
- nenhum `ROTAMOTO_BACKUP_CONTROL_GROUP_GID`

Diretórios de controle e arquivos mantêm permissões privadas (`0700`/`0600`), o executor continua em processo separado, usa lease e só despacha operações enumeradas. A política informa `termux-shared-uid` na interface. Isso reduz exposição acidental, mas **não isola o executor do servidor comprometido sob o mesmo UID**: ambos podem ler arquivos privados acessíveis ao UID e inspecionar processos da mesma identidade. Não tratar esta instalação como equivalente ao isolamento Linux. Não ativar backup real no Termux para dados operacionais até a avaliação e autorização operacional de risco.

O teste 0229 usa apenas artefatos sintéticos em diretórios privados do run e um cluster PostgreSQL local descartável. Nenhum serviço runit global foi alterado. Os comandos de implantação runit permanecem manuais e não são aplicados por esta campanha.

## Linux e contêiner

Em Linux/contêiner, a política requer executor com UID dedicado diferente do processo HTTP e grupo dedicado para o diretório de controle. O HTTP deve receber somente acesso ao diretório/IPC necessário, sem URL de banco, chave de criptografia, destino remoto ou privilégios `BYPASSRLS`. A identidade de backup e as credenciais ficam no ambiente/arquivos protegidos do executor. O executor deve ser provisionado pelo operador com serviço systemd (Linux) ou supervisor do contêiner. Esta campanha não instalou serviços do sistema.

Critérios de implantação: arquivos de segredo `0600`, diretórios `0700` (ou grupo explicitamente controlado para o canal IPC), armazenamento de recovery sets separado, identidade de backup dedicada e sem acesso interativo/rede desnecessário, destino de restore descartável allowlisted, e verificação de permissões antes de iniciar. Não passar segredos por argumento de processo nem publicá-los no painel/logs.

## Agendamento e recuperação

O scheduler roda dentro do executor independente do navegador e persiste o slot antes de criar o job, prevenindo duplicação após restart. O heartbeat persistido diferencia `ONLINE`, `STALE`, `OFFLINE` e `UNKNOWN`; ele indica processo vivo, não prova que o job mais recente foi íntegro. Validar sempre status do job, inventário criptográfico e evento de auditoria.

Runbook local: verificar readiness do runtime e estado do executor; conferir `QUEUED`/`RUNNING`/`UNKNOWN_OUTCOME`; consultar inventário; preservar jobs de resultado incerto para análise; corrigir configuração e enfileirar uma nova operação idempotente com chave nova somente após verificar o recovery set anterior. Nunca usar retry automático para um restore de resultado incerto. Restore de ensaio exige solicitante e aprovador distintos, MFA recente e executa apenas em destino descartável.

## Evidência e limites da 0229

O runner `campaign-0229-backup-center.cjs` executa o runtime HTTP e o executor como processos distintos, com Chromium/CDP autenticado e PostgreSQL descartável criado pelo próprio teste. Ele prova a política Termux compartilhada, backup manual e agendado, criptografia/verificação, restart, aprovação bilateral e restore sintético. Não prova instalação de daemon global, isolamento contra comprometimento do mesmo UID, cópia externa, provisionamento real de Linux/contêiner ou prontidão de produção.
