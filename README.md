# Xama Mobilidade CRM

CRM web para motoristas, corridas, pagamentos, carteira e fechamentos individuais. A interface continua sendo React/Vite; o servidor Node entrega a aplicação, protege os endpoints e, em produção, persiste os dados em PostgreSQL.

## Requisitos

- Node.js 22.14 ou superior (`.node-version`)
- PostgreSQL para produção
- Chave Gemini API com acesso ao modelo Flash para análise contextual real

## Desenvolvimento local

```powershell
npm install
npm run dev
```

Sem `DATABASE_URL`, o Vite usa explicitamente o modo local anterior, com dados no `localStorage` do navegador. Esse modo é apenas para desenvolvimento e não oferece autenticação nem sincronização entre dispositivos.

Para executar o servidor de produção localmente, configure as variáveis do `.env.example`, gere o build e inicie:

```powershell
npm run build
npm start
```

Em produção o servidor escuta a porta `PORT` em todas as interfaces e se recusa a iniciar sem `DATABASE_URL` e sem uma primeira conta administradora válida.

## Persistência e contas

O banco PostgreSQL armazena as contas, sessões e um estado versionado da empresa. O esquema é criado pelo backend na inicialização. Todos os usuários da organização Xama compartilham os mesmos cadastros e registros financeiros.

1. Configure `DATABASE_URL`, `INITIAL_ADMIN_EMAIL` e `INITIAL_ADMIN_PASSWORD` no ambiente do servidor. A senha inicial deve ter pelo menos 12 caracteres.
2. No primeiro início, o backend cria a organização e a conta administradora. Remova `INITIAL_ADMIN_PASSWORD` do provedor depois que a conta tiver sido criada.
3. O administrador pode criar contas individuais em **Contas de acesso** no cabeçalho. As senhas são armazenadas com scrypt; sessões usam cookies HttpOnly, SameSite e Secure em produção.
4. No primeiro acesso autenticado, os dados deste navegador são migrados para o banco somente se ainda não existir um estado compartilhado. Se o banco já tiver dados diferentes e este navegador também tiver registros, o CRM solicita baixar um backup local antes de abrir o estado compartilhado.
5. Cada gravação usa uma versão otimista. Se outra sessão alterar o estado primeiro, o CRM bloqueia a gravação conflitante, mantém a cópia local e exige uma escolha explícita; não sobrescreve silenciosamente os dados do servidor.

O banco é a cópia compartilhada e persistente. O `localStorage` permanece como cache local e fonte de backup durante migração/indisponibilidade. Faça backups regulares do PostgreSQL no provedor.

## Importação e fechamento

- A extração do ZIP/TXT ocorre no navegador. A importação individual associa a conversa ao cadastro selecionado e respeita as datas inicial/final daquele motorista.
- Análises reais usam a API oficial do Google Gemini somente no backend, com `GEMINI_API_KEY`. O transporte padrão é `generateContent`; `GEMINI_API_MODE=interactions` seleciona a Interactions API existente. Antes do envio, o conteúdo é minimizado e tenta mascarar nomes, telefones, endereços, e-mails, documentos e links. O ZIP original e a chave da API não são enviados.
- A anonimização textual é heurística e não garante remover todo dado pessoal de texto livre. Não envie conversas que a empresa não possa compartilhar com o Google Gemini.
- A IA indisponível não produz resultados substitutos: erros e itens ambíguos continuam visíveis para conferência. Corridas confirmadas validadas e regras atuais de comissão são calculadas no CRM em centavos.
- O modelo padrão é `gemini-3.5-flash-lite`; `GEMINI_MODEL` pode selecionar outro modelo Flash habilitado na conta.
- Os testes locais usam respostas de teste injetadas, não consomem créditos nem substituem uma análise real de conversa. Faça uma análise real controlada antes de validar o ZIP do Bryan.

## Variáveis de ambiente

Copie `.env.example` para `.env` somente em desenvolvimento. `.env` é ignorado pelo Git.

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | URL privada do PostgreSQL |
| `INITIAL_ADMIN_EMAIL` | E-mail para a primeira conta administradora |
| `INITIAL_ADMIN_PASSWORD` | Senha inicial (mínimo 12 caracteres); remover após bootstrap |
| `GEMINI_API_KEY` | Chave secreta usada exclusivamente pelo backend |
| `GEMINI_MODEL` | Modelo Gemini Flash; padrão `gemini-3.5-flash-lite` |
| `GEMINI_API_MODE` | `generateContent` (padrão) ou `interactions` |
| `PORT` | Porta fornecida pelo provedor de hospedagem |

Nunca use variáveis com prefixo `VITE_` para segredos.

## Publicação no Render

`render.yaml` declara o serviço web, os comandos de build/início, health check e variáveis secretas. Ele não cria um banco pago automaticamente.

Antes de publicar no GitHub ou conectar o repositório ao Render, remova do histórico Git qualquer arquivo de conversa ou backup que já tenha sido commitado. A regra `*.zip` no `.gitignore` impede novos ZIPs, mas não apaga blobs de commits anteriores; trate esses dados como já expostos se o histórico tiver sido enviado a um remoto.

1. Crie um PostgreSQL gerenciado no Render e configure a URL de conexão **interna/privada** como `DATABASE_URL` do serviço web.
2. Crie o Web Service a partir deste projeto ou aplique o Blueprint.
3. Configure `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` e `GEMINI_API_KEY` na área de segredos do serviço. `GEMINI_MODEL` usa `gemini-3.5-flash-lite` e `GEMINI_API_MODE` usa `generateContent` por padrão. Use uma senha aleatória de pelo menos 12 caracteres; não a inclua no repositório.
4. Use Node 22.14+, `npm ci && npm run build` e `npm start`; o health check é `/api/health`.
5. Aguarde o health check conectar ao PostgreSQL, entre com a conta inicial e confirme os cadastros importados.
6. Remova a senha inicial do ambiente após o bootstrap, configure domínio próprio e HTTPS no provedor e teste login, logout, migração, gravação e restauração de backup.
7. Habilite créditos da API somente quando a empresa autorizar. Faça primeiro uma análise real controlada e revise mensagens/valores antes de aprovar corridas.

## Verificações locais

```powershell
npm test
npm run lint
npm run build
```

Os testes de backend usam respostas de teste injetadas para validar o contrato e não simulam resultados como se fossem análise real. Uma conexão real ao PostgreSQL, uma chamada real ao Gemini, o fechamento de referência do Bryan e o deploy precisam ser verificados no ambiente com credenciais e recursos configurados.
