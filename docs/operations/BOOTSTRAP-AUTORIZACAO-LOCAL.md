# Autorização local para primeira instalação

Este procedimento prepara o Bootstrap web para uma única instalação inicial no banco oficial `rotamoto`. Ele não cria empresa, fundador ou usuário. A instalação só é gravada quando o proprietário envia o formulário final no navegador.

## Pré-requisitos

- Termux local no dispositivo que executa os serviços RotaMoto.
- Checkout Restaurante em `$HOME/projetos/repos/rota-moto-restaurante`, dependências Node instaladas e runtime Node compatível com `package.json`.
- API oficial, PostgreSQL, migrations e keystore MFA funcionando.
- Conexão configurada para o banco exato `rotamoto` como `rotamoto_app`, sem senha embutida na URL. O script oficial confirma essa identidade dentro do PostgreSQL.
- A primeira instalação ainda precisa estar disponível. Banco inicial vazio sozinho não basta: latches, fundador e estado de identidade também são avaliados pela função SQL oficial.

## Verificar os serviços

No navegador local, abra `http://127.0.0.1:8083/bootstrap.html`. A etapa Diagnóstico consulta API, banco, migrations e keystore. A API oficial deve responder `ready` em `/health/ready`; o status de Bootstrap deve responder `state=ready`.

SMTP pendente significa que o transporte não está configurado/testado. Ele pode ser configurado na etapa E-mail e notificações; não bloqueia o modo local-only. Convites enviados por e-mail exigem transporte SMTP funcional e uma URL pública HTTPS. Endereços loopback (`127.0.0.1`, `localhost`) só apontam para o próprio dispositivo. LAN alcança outros dispositivos da rede. A autorização de primeira instalação e o handoff local ficam limitados ao loopback; a rede local não é tratada como identidade do operador. O acesso público precisa de domínio/URL HTTPS e não é habilitado por esta autorização local.

## Emitir autorização no Termux

Execute exatamente a partir do checkout Restaurante:

```sh
cd "$HOME/projetos/repos/rota-moto-restaurante" && npm run bootstrap:prepare-browser
```

O script npm expande para `node scripts/prepare-browser-bootstrap.js --confirm-database=rotamoto`. A verificação automatizada dos gates pode ser feita sem emissão usando `node tests/test-browser-bootstrap-cli.js`; ela não prepara uma autorização real.

O emissor requer terminal interativo (stdin e stdout TTY), Android/Termux local (sem sessão SSH), confirmação textual `PREPARAR PRIMEIRA INSTALACAO`, ambiente diferente de test, URL do banco oficial sem senha embutida, usuário e banco exatos, keystore MFA válido, estado inicial `ready` e nenhuma autorização ainda ativa. Ele toma um lock transacional no banco, gera 32 bytes criptograficamente aleatórios, codifica-os em Base64URL e grava apenas SHA-256 da representação Base64URL que a API validará. O token expira em 10 minutos e é impresso uma vez no terminal. Não registre, fotografe, envie por mensagem nem coloque o valor em argumentos de shell.

Saída ilustrativa, com marcador fictício não utilizável:

```text
Autorização inicial (válida por 10 minutos; use uma única vez):
<AUTORIZACAO_FICTICIA_NAO_UTILIZAVEL>

Cole o código somente na página local de primeira instalação. Não o salve nem o envie a outra pessoa.
```

## Inserir e concluir a etapa 2

1. Na página Bootstrap aberta em `127.0.0.1:8083`, avance do Diagnóstico para Administrador fundador.
2. Informe o e-mail real do titular.
3. Cole a autorização do terminal no campo **Autorização local de uso único**. O campo é mascarado; o valor não é persistido no rascunho do browser nem escrito em logs.
4. Continue preenchendo as etapas do assistente. Voltar à etapa 2 mantém a autorização apenas na memória da página.
5. Revise os dados. A submissão consome a autorização de forma atômica na mesma transação que reserva a instalação; submissões concorrentes não podem criar duas instalações.
6. No modo local-only, o sistema devolve um handoff local de uso único. O titular define a senha e configura/confirma MFA. O privilégio fundador depende da confirmação MFA. A autorização do operador e o link de ativação do titular são tokens distintos.

## Expiração e falhas comuns

- **Autorização inválida, expirada ou já consumida:** não tente reutilizá-la. Uma tentativa de emissão enquanto houver autorização ativa falha de propósito. Aguarde a expiração de 10 minutos e execute novamente o comando; o emissor confirma o estado inicial antes de gerar outra.
- **Terminal interativo obrigatório:** execute no app Termux com sessão TTY local, não em tarefa automatizada/pipe. O gate verifica TTY, confirmação, identidade SQL e keystore; loopback isoladamente não autoriza a emissão.
- **Alvo ou papel incorreto:** confira o ambiente de execução oficial. O emissor recusa qualquer banco/role diferente de `rotamoto`/`rotamoto_app`; não altere para contornar o gate.
- **Keystore indisponível:** interrompa a instalação e corrija a configuração de secrets/MFA por operação administrativa. Não regenere, sobrescreva nem apague chaves como tentativa de recuperação.
- **Banco já inicializado ou reservado:** o emissor não emite outro código. Reinstalação ou recuperação exige procedimento administrativo próprio e autorização explícita; não limpe latches nem dados.
- **API ou schema indisponível:** corrija serviço/migrations antes de emitir; não reaplique migrations já registradas.

## Garantias e limites

- O navegador não tem endpoint de emissão. SMTP/setup e provisionamento exigem o token temporário em cabeçalho; API também confere peer TCP loopback e origem local. A origem/peer limitam a superfície de rede, mas não substituem o gate do CLI.
- O CLI exige TTY, indicadores de runtime Android/Termux, ausência dos indicadores comuns de SSH, confirmação explícita, identidade SQL da instalação oficial, estado Bootstrap inicial e keystore que passa teste de gravação/leitura/remoção de um canário temporário. O papel `rotamoto_app` é a identidade local de banco permitida; acesso a essa identidade e ao keystore compõe o limite de confiança do operador Termux. Os indicadores de ambiente não são prova criptográfica contra outro processo sob o mesmo UID; o mecanismo protege contra emissão pública/anônima e ambientes remotos comuns, não contra comprometimento da conta Termux ou do próprio dispositivo.
- O banco mantém apenas digest SHA-256, escopo `rotamoto`, criação/expiração e consumo. Os privilégios do runtime permanecem limitados às operações já previstas; a transação serializa o consumo e preserva o latch fundador, MFA, RBAC e RLS.
- Não há prova de que um humano específico está diante do Termux além da sessão local autorizada e do controle do ambiente/keystore. Proteja o desbloqueio do dispositivo e o acesso ao Termux. A execução remota/automatizada não é o fluxo suportado.
- A repetição idempotente da mesma solicitação já registrada pode recuperar a resposta de uma operação interrompida; não autoriza um segundo fundador nem uma nova chave de instalação.

## Verificação read-only

Use a tela Diagnóstico e os endpoints locais publicados para verificar estado/readiness. Não rode comandos de reset, limpeza de dados ou alteração de latches para diagnosticar. Para instalação real, o proprietário deve revisar todos os dados no navegador e decidir quando pressionar **Iniciar instalação**.
