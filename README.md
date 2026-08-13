# Almoxarifado — controle de estoque

Site estático (HTML, CSS e JavaScript puros, sem build) com dados no Supabase.
Funciona em celular, tablet e desktop, e imprime etiquetas QR, relatório diário e pedido de compra.

---

## 1. Subir no GitHub

```bash
cd almoxarifado
git init
git add .
git commit -m "Almoxarifado — versão inicial"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/almoxarifado.git
git push -u origin main
```

## 2. Publicar na Vercel

1. Acesse **vercel.com/new** e escolha **Import Git Repository**.
2. Selecione o repositório `almoxarifado`.
3. Em *Framework Preset*, deixe **Other**. Não preencha build command nem output directory — é site estático.
4. **Deploy**. O link sai em cerca de 40 segundos, no formato `https://almoxarifado-xxxx.vercel.app`.

Cada `git push` na branch `main` republica sozinho.

---

## 3. Dois ajustes no painel do Supabase (obrigatórios antes do primeiro acesso)

Projeto **cobreai-prod** → *Authentication* → *Sign In / Providers*:

| Ajuste | Onde | Por quê |
|---|---|---|
| **Email** ligado | Providers → Email | O login é por celular, mas o Supabase ancora a conta num e-mail interno gerado a partir do número. |
| **Confirm email** desligado | Providers → Email | O e-mail interno (`5511...@almox.local`) não existe de verdade e nunca receberá mensagem. Com a confirmação ligada, ninguém consegue entrar. |

Se o Supabase recusar o domínio `almox.local` no cadastro, troque `DOMINIO_INTERNO`
em `assets/config.js` por um domínio que você controle e publique de novo.

Recomendado também: *Authentication → Policies → Leaked password protection* ligado.

---

## 4. Primeiro acesso

O **primeiro celular cadastrado vira admin automaticamente**. Faça esse cadastro você mesmo,
antes de passar o link para a equipe. Os seguintes entram como `almoxarife`, e você promove
a `gestor` na aba **Cadastros → Equipe**.

| Papel | Pode |
|---|---|
| `almoxarife` | Dar baixa, registrar entrada, contar inventário, imprimir etiquetas e relatórios |
| `gestor` / `admin` | Tudo acima, mais cadastrar produtos e fornecedores, abrir e fechar inventário, administrar a equipe |

---

## 5. O que o banco garante (não depende do navegador)

- **Saldo só muda por movimento gravado.** Um gatilho no Postgres trava a linha do produto, valida e recalcula. Duas pessoas bipando o mesmo item ao mesmo tempo não se atropelam.
- **Saída maior que o saldo é recusada pelo banco**, com mensagem, não por validação de tela.
- **Movimentações são imutáveis.** Não existe política de UPDATE nem DELETE em `alm_movimentos` — nem admin altera. Correção se faz por inventário, que registra o ajuste.
- **RLS ativa em todas as tabelas.** Sem sessão válida, a API não devolve nada.
- **Nenhuma função é executável por visitante anônimo.**

## 6. Estrutura

```
index.html            tela única (login + aplicação)
assets/config.js      URL e chave publicável do Supabase
assets/styles.css     identidade visual
assets/app.js         toda a lógica
banco-almoxarifado.sql  estrutura completa do banco (já aplicada)
```

A chave em `config.js` é a *publishable key* — ela é pública por definição e não dá acesso a nada:
quem protege os dados é a RLS. **Nunca** coloque aqui a `service_role`.
