# Bootstrap local da primeira identidade

## Escopo e proteção

O bootstrap é executado somente por um operador local em terminal interativo. O servidor HTTP e a interface web nunca inicializam instalação automaticamente. O comando exige confirmação explícita do banco `rotamoto`, frase de confirmação, conexão como `rotamoto_app`, migrations `0045` e `0046`, keystore protegido com segredo do banco, provedor MFA nativo e entrega de email configurada. O serviço recusa instalação já inicializada; a migration `0046` também fecha o caminho de primeira instalação quando já existem empresas ou registros de provisionamento.

Durante esta campanha, o comando real não foi executado. Não houve criação de empresa, proprietário ou usuário real. O teste exercitou a mesma transação em `rotamoto_e2e` dentro de rollback e com destinatários sintéticos.

## Preparar infraestrutura local

1. Configure o Secret Store e a credencial da role runtime conforme [SELF-HOSTED-DEPLOYMENT.md](../SELF-HOSTED-DEPLOYMENT.md). Em Termux, proteja diretório e arquivo de chave com modo `0700`/`0600`; não grave segredos em `.env`, argumentos ou Git.
2. Configure SMTP com TLS validado, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD_REF`, `SMTP_FROM` e `PUBLIC_BASE_URL` HTTPS para que o link de convite retorne ao aplicativo.
3. Configure o arquivo de auditoria local e `ROTAMOTO_OPERATOR_ACTOR_REF`. O arquivo deve ser privado, pertencente ao usuário efetivo e sem symlinks.
4. Aplique previamente migrations revisadas com o runner apropriado. O serviço não executa migrations durante a inicialização.
5. Confirme que o serviço PostgreSQL responde e que o keystore/SMTP podem ser lidos. Não use `bootstrap-owner` como teste de conectividade.

## Provisionar quando houver autorização específica

O comando abaixo é deliberadamente omitido da rotina automática de deploy:

```sh
node scripts/bootstrap-owner.js --confirm-database=rotamoto
```

Informe o nome inicial da empresa e o email do proprietário no terminal; em seguida digite exatamente `PROVISIONAR PRIMEIRO PROPRIETARIO`. O comando comprova `current_database()` e `current_user`, grava somente o hash de uma capacidade aleatória com expiração de dez minutos, e passa o digest ao serviço em memória. A transação serializa inicializações concorrentes, consome a capacidade e cria empresa, usuário, role, membership, convite e auditoria. A senha é definida no link de convite, que é de uso único e confirma posse do email.

Se a entrega falhar depois do commit, o comando informa `operationKey`. Corrija o SMTP e execute novamente com os mesmos dados e a chave original:

```sh
node scripts/bootstrap-owner.js --confirm-database=rotamoto --retry-key=bootstrap-<uuid>
```

O retry não pode trocar empresa/email e não pode provisionar outro proprietário. Não copie tokens de convite para logs ou tickets. O proprietário deve definir senha, entrar, concluir enrollment TOTP e guardar os códigos de recuperação antes de usar funções administrativas.

## Desenvolvimento sintético

Testes automatizados usam exclusivamente `rotamoto_e2e` ou bancos descartáveis e dados `example.invalid`. A suite PostgreSQL de migrações antigas que exige rollback/limpeza permanece bloqueada para o banco E2E compartilhado; não execute essa suite contra o banco oficial. Não classifique as fixtures de email locais como entrega real por provedor externo.

## Estado de validação desta implementação

- O gate PostgreSQL E2E exercitou emissão/consumo de capacidade, falta de autorização, replay idempotente e bloqueio de segundo bootstrap por rollback.
- A inicialização interativa contra `rotamoto` não foi executada.
- Entrega SMTP externa, HTTPS público e acesso de proprietário real dependem de configuração e autorização futura.
