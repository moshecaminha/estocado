/* ===================================================================
   ALMOXARIFADO — aplicação de produção
   Dados no Supabase, protegidos por RLS. O saldo nunca é escrito pelo
   navegador: ele é consequência do movimento gravado no banco.
   =================================================================== */

const VERSAO = 'v4 · 13/08 login por usuário';
console.log('Almoxarifado', VERSAO);

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

/* ---------------- estado ---------------- */
let S = { produtos:[], fornecedores:[], setores:[], pessoas:[], movimentos:[], inventario:null, itensInv:[] };
let perfil = null;
let vista = 'painel';
let selecionado = null;
let etqSel = new Set();
let leitorCam = null;
let abaLogin = 'entrar';
const F = { pBusca:'', pCat:'', pBaixo:false, mDe:'', mAte:'', mTipo:'', eCat:'', rData:'', iBusca:'', iSoFalta:false };

/* ---------------- utilitários ---------------- */
const el = id => document.getElementById(id);
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n = v => Number(v||0);
const num = v => n(v).toLocaleString('pt-BR',{maximumFractionDigits:3});
const dinheiro = v => n(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const hoje = () => new Date().toLocaleDateString('sv-SE');
const diaDe = iso => new Date(iso).toLocaleDateString('sv-SE');
const dataBR = d => { const [a,m,x]=String(d).slice(0,10).split('-'); return `${x}/${m}/${a}`; };
const horaBR = iso => new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
const acha = c => S.produtos.find(p=>p.codigo.toUpperCase()===String(c||'').trim().toUpperCase());
const porId = id => S.produtos.find(p=>p.id===id);
const forn = id => S.fornecedores.find(f=>f.id===id);
const abaixo = p => n(p.estoque) <= n(p.minimo);
const repor = p => Math.max(n(p.maximo)-n(p.estoque), n(p.minimo));
const ehGestor = () => perfil && (perfil.papel==='gestor' || perfil.papel==='admin');
const soDigitos = s => String(s||'').replace(/\D/g,'');

function aviso(msg,tipo=''){
  const d=document.createElement('div'); d.className='aviso '+tipo; d.textContent=msg;
  el('avisos').appendChild(d); setTimeout(()=>d.remove(),4200);
}
function modal(titulo, corpo, pe){
  el('modais').innerHTML = `<div class="cortina"><div class="modal" role="dialog" aria-modal="true">
    <div class="modal-cab"><h3>${esc(titulo)}</h3><button data-acao="fechar-modal" aria-label="Fechar">&times;</button></div>
    <div class="modal-corpo">${corpo}</div>${pe?`<div class="modal-pe">${pe}</div>`:''}</div></div>`;
}
const fecharModal = () => el('modais').innerHTML='';
function erroBanco(e){
  const m = (e && (e.message || e.error_description)) || 'Falha na comunicação com o banco';
  if(/insuficiente/i.test(m)) return m;
  if(/violates row-level security|permission denied/i.test(m)) return 'Seu perfil não tem permissão para esta ação.';
  if(/duplicate key/i.test(m)) return 'Já existe um registro com esse código.';
  return m;
}
function csvLinha(v){ return v.map(x=>{const s=String(x??''); return /[";\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join(';'); }
function baixarArquivo(nome, texto, tipo='text/csv;charset=utf-8'){
  const b=new Blob(['\ufeff'+texto],{type:tipo});
  const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download=nome;
  document.body.appendChild(a); a.click(); a.remove(); aviso('Arquivo gerado: '+nome,'bom');
}
function parseCSV(txt){
  const linhas=[]; let campo='',linha=[],aspas=false;
  txt=txt.replace(/\r\n?/g,'\n');
  for(let i=0;i<txt.length;i++){ const c=txt[i];
    if(aspas){ if(c==='"'){ if(txt[i+1]==='"'){campo+='"';i++;} else aspas=false; } else campo+=c; }
    else if(c==='"') aspas=true;
    else if(c===';'||c===','||c==='\t'){ linha.push(campo); campo=''; }
    else if(c==='\n'){ linha.push(campo); linhas.push(linha); linha=[]; campo=''; }
    else campo+=c; }
  if(campo||linha.length){ linha.push(campo); linhas.push(linha); }
  return linhas.filter(l=>l.some(c=>String(c).trim()!==''));
}
const urlEtiqueta = codigo => (CONFIG.URL_BASE||location.origin).replace(/\/$/,'') + '/?c=' + encodeURIComponent(codigo);
/* aceita etiqueta nova (endereço) e etiqueta antiga (só o código) */
function codigoDaLeitura(txt){
  const t = String(txt||'').trim();
  const m = t.match(/[?&]c=([^&#\s]+)/i);
  if(m) return decodeURIComponent(m[1]);
  if(/^https?:\/\//i.test(t)){ const f = t.split('/').filter(Boolean).pop()||''; return decodeURIComponent(f.split('?')[0]); }
  return t;
}
function gerarQR(destino, texto, tamanho){
  destino.innerHTML='';
  if(typeof QRCode==='undefined'){ destino.innerHTML=`<div class="mono" style="font-size:9px">${esc(texto)}</div>`; return; }
  new QRCode(destino,{text:texto,width:tamanho,height:tamanho,correctLevel:QRCode.CorrectLevel.M});
}

/* ===================================================================
   AUTENTICAÇÃO — celular + senha
   =================================================================== */
const limparUsuario = u => String(u||'').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'');
const emailInterno = usuario => limparUsuario(usuario) + '@' + CONFIG.DOMINIO_INTERNO;
function msgLogin(txt, ok){ el('msgLogin').innerHTML = txt ? `<div class="${ok?'ok-login':'erro-login'}">${esc(txt)}</div>` : ''; }

/* A tela de acesso tem três estados:
   configurar → sistema ainda sem administrador (só acontece uma vez)
   entrar     → uso normal
   ativar     → quem recebeu convite do administrador define a própria senha  */
async function montarLogin(){
  let precisa = false;
  try{
    const { data, error } = await sb.rpc('alm_precisa_configurar');
    if(error) throw error;
    precisa = !!data;
  }catch(e){
    msgLogin('Não consegui falar com o banco: '+(e.message||e));
  }
  abaLogin = precisa ? 'configurar' : 'entrar';
  pintarLogin();
}
function pintarLogin(){
  const modo = abaLogin;
  el('subLogin').textContent = modo==='configurar' ? 'Primeiro acesso · criação do administrador'
    : modo==='ativar' ? 'Ativação de acesso liberado pelo administrador'
    : 'Controle de estoque · acesso restrito';

  el('areaLogin').innerHTML = `
    ${modo==='configurar' ? `<p class="legenda">Ninguém tem acesso ainda. Crie aqui a conta de administrador — depois dela, o cadastro fecha e novos usuários só entram por liberação sua.</p>` : ''}
    ${modo!=='entrar' ? `<label class="campo"><span>Nome completo</span>
      <input id="lgNome" type="text" autocomplete="name" placeholder="Como aparece nos relatórios"></label>` : ''}
    <label class="campo"><span>Usuário</span>
      <input id="lgUsuario" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="ex.: estocado"></label>
    <label class="campo"><span>Senha</span>
      <input id="lgSenha" type="password" autocomplete="${modo==='entrar'?'current-password':'new-password'}" placeholder="Mínimo de 6 caracteres"></label>
    <button class="btn gr" id="btnLogin" data-acao="login">${
      modo==='configurar' ? 'Criar administrador' : modo==='ativar' ? 'Ativar meu acesso' : 'Entrar'}</button>
    ${modo==='entrar'
      ? `<p class="legenda" style="text-align:center;margin:16px 0 0">Recebeu um usuário do administrador?
         <a href="#" data-acao="modo-ativar" style="color:var(--tinta);font-weight:600">Defina sua senha</a></p>`
      : modo==='ativar'
      ? `<p class="legenda" style="text-align:center;margin:16px 0 0"><a href="#" data-acao="modo-entrar" style="color:var(--tinta);font-weight:600">Voltar para entrar</a></p>` : ''}`;
  el('areaLogin').insertAdjacentHTML('beforeend',
    `<p class="mono" style="text-align:center;font-size:10px;color:var(--mute);margin:18px 0 0">${esc(VERSAO)}</p>`);
  el('lgUsuario').focus();
}
function trocarModoLogin(m){ abaLogin = m; msgLogin(''); pintarLogin(); }

async function enviarLogin(){
  const usuario = limparUsuario(el('lgUsuario').value);
  const senha = el('lgSenha').value;
  const nome = el('lgNome') ? el('lgNome').value.trim() : '';
  const btn = el('btnLogin');
  if(!usuario){ msgLogin('Informe o usuário.'); return; }
  if(senha.length < 6){ msgLogin('A senha precisa de pelo menos 6 caracteres.'); return; }
  if(abaLogin!=='entrar' && !nome){ msgLogin('Informe seu nome — ele aparece em cada baixa registrada.'); return; }

  btn.disabled = true; btn.textContent = 'Aguarde…'; msgLogin('');
  try{
    const email = emailInterno(usuario);
    if(abaLogin==='entrar'){
      const { error } = await sb.auth.signInWithPassword({ email, password: senha });
      if(error) throw error;
    } else {
      const { error } = await sb.auth.signUp({ email, password: senha, options:{ data:{ nome, usuario } } });
      if(error && !/already registered|User already/i.test(error.message)) throw error;
      const { error: e2 } = await sb.auth.signInWithPassword({ email, password: senha });
      if(e2) throw e2;
    }
    const { error: e3 } = await sb.rpc('alm_garantir_perfil', { p_nome: nome||null, p_telefone: null });
    if(e3){ await sb.auth.signOut(); throw e3; }
    await entrarNoSistema();
  }catch(e){
    const m = String(e.message||e);
    if(/não autorizado/i.test(m)) msgLogin(m);
    else if(/Invalid login credentials/i.test(m)) msgLogin(abaLogin==='entrar'
      ? 'Usuário ou senha não conferem.'
      : 'Esse usuário já existe com outra senha. Peça ao administrador para reativar seu acesso.');
    else if(/signups not allowed|Signups not allowed/i.test(m)) msgLogin('Cadastro bloqueado no Supabase: ative "Allow new users to sign up" em Authentication → Sign In / Providers.');
    else if(/Email logins are disabled/i.test(m)) msgLogin('Ative o provedor Email em Authentication → Sign In / Providers no Supabase.');
    else if(/confirm/i.test(m)) msgLogin('Desligue "Confirm email" em Authentication → Sign In / Providers no Supabase.');
    else if(/invalid.*email/i.test(m)) msgLogin('O Supabase recusou o domínio interno. Troque DOMINIO_INTERNO em assets/config.js.');
    else msgLogin(m);
    pintarLogin();
  }
}

async function sair(){
  await pararCamera();
  await sb.auth.signOut();
  perfil=null; S.produtos=[];
  el('app').style.display='none'; el('login').style.display='flex';
  await montarLogin();
}

async function entrarNoSistema(){
  const { data:{ user } } = await sb.auth.getUser();
  if(!user) return;
  const { data: p, error } = await sb.rpc('alm_garantir_perfil', { p_nome:null, p_telefone:null });
  if(error){ await sb.auth.signOut(); msgLogin(erroBanco(error)); await montarLogin(); return; }
  perfil = Array.isArray(p) ? p[0] : p;
  if(!perfil.ativo){ await sb.auth.signOut(); msgLogin('Seu acesso está desativado. Procure o administrador do almoxarifado.'); return; }
  el('login').style.display='none'; el('app').style.display='block';
  el('nomeEmpresa').textContent = CONFIG.EMPRESA;
  el('quemSou').innerHTML = `${esc(perfil.nome)} <span class="papel">${esc(perfil.papel)}</span>`;
  await recarregar();
  const pedido = new URLSearchParams(location.search).get('c');
  if(pedido){
    history.replaceState(null,'','/');
    const p = acha(pedido);
    if(p){ vista='saida'; selecionado=p; pintarAbas(); render();
      setTimeout(()=>{ const q=el('fQtd'); if(q){ q.focus(); q.select(); } },120);
      return;
    }
    aviso('Etiqueta lida: código '+pedido+' não está cadastrado.','ruim');
  }
  pintarAbas(); render();
}

/* ===================================================================
   CARGA DE DADOS
   =================================================================== */
async function recarregar(){
  const [prod, forns, sets, movs, inv] = await Promise.all([
    sb.from('alm_produtos').select('*').eq('ativo',true).order('codigo'),
    sb.from('alm_fornecedores').select('*').order('nome'),
    sb.from('alm_setores').select('*').order('nome'),
    sb.from('alm_movimentos').select('*').order('data',{ascending:false}).limit(1000),
    sb.from('alm_inventarios').select('*').eq('status','aberto').maybeSingle()
  ]);
  for(const r of [prod,forns,sets,movs]) if(r.error) throw r.error;

  S.produtos = (prod.data||[]).map(p=>({...p, estoque:n(p.estoque), minimo:n(p.minimo), maximo:n(p.maximo), preco:n(p.preco)}));
  S.fornecedores = forns.data||[];
  S.setores = sets.data||[];
  S.movimentos = (movs.data||[]).map(m=>({...m, qtd:n(m.qtd), preco:n(m.preco), saldo_depois:n(m.saldo_depois)}));
  S.pessoas = [...new Set(S.movimentos.map(m=>m.solicitante).filter(x=>x && x!=='—'))].slice(0,60);
  S.inventario = inv.data||null;
  S.itensInv = [];
  if(S.inventario){
    const { data } = await sb.from('alm_inventario_itens').select('*').eq('inventario_id',S.inventario.id);
    S.itensInv = (data||[]).map(i=>({...i, saldo_sistema:n(i.saldo_sistema), contado: i.contado===null?null:n(i.contado)}));
  }
}

/* ===================================================================
   NAVEGAÇÃO
   =================================================================== */
const ABAS = [['painel','Painel'],['saida','Baixa'],['entrada','Entrada'],['inventario','Inventário'],
              ['produtos','Produtos'],['etiquetas','Etiquetas QR'],['movimentos','Movimentações'],
              ['relatorio','Fechamento'],['cadastros','Cadastros']];
function pintarAbas(){
  const pend = S.produtos.filter(abaixo).length;
  el('abas').innerHTML = ABAS.map(([id,rot])=>{
    const pino = id==='relatorio'&&pend ? `<span class="pino">${pend}</span>`
               : id==='inventario'&&S.inventario ? `<span class="pino" style="background:var(--ok)">●</span>` : '';
    return `<button class="aba" data-acao="ir" data-vista="${id}" aria-current="${vista===id}">${rot}${pino}</button>`;
  }).join('');
}
async function ir(v){ await pararCamera(); vista=v; selecionado=null; pintarAbas(); render(); window.scrollTo(0,0); }

function render(){
  const t = el('tela');
  const mapa = {painel:vPainel, saida:()=>vMovimento('saida'), entrada:()=>vMovimento('entrada'),
    inventario:vInventario, produtos:vProdutos, etiquetas:vEtiquetas, movimentos:vMovimentos,
    relatorio:vRelatorio, cadastros:vCadastros};
  t.innerHTML = (mapa[vista]||vPainel)();
  document.querySelectorAll('[data-qr]').forEach(d=>gerarQR(d,d.dataset.qr,Number(d.dataset.tam||76)));
  const bip = el('campoBip'); if(bip && !selecionado) setTimeout(()=>bip.focus(),60);
}

/* ===================================================================
   PAINEL
   =================================================================== */
function vPainel(){
  const d = hoje();
  const saidasHoje = S.movimentos.filter(m=>m.tipo==='saida'&&diaDe(m.data)===d);
  const entradasHoje = S.movimentos.filter(m=>m.tipo==='entrada'&&diaDe(m.data)===d);
  const repoe = S.produtos.filter(abaixo).sort((a,b)=>(a.estoque/(a.minimo||1))-(b.estoque/(b.minimo||1)));
  const valor = S.produtos.reduce((s,p)=>s+p.estoque*p.preco,0);
  const dias=[]; for(let i=6;i>=0;i--){ const x=new Date(); x.setDate(x.getDate()-i); dias.push(x.toLocaleDateString('sv-SE')); }
  const serie = dias.map(dia=>S.movimentos.filter(m=>m.tipo==='saida'&&diaDe(m.data)===dia).reduce((s,m)=>s+m.qtd,0));
  const topo = Math.max(1,...serie);
  const ult = S.movimentos.slice(0,8);

  return `
  <div class="kpis" style="margin-bottom:16px">
    <div class="kpi"><div class="rot">Itens cadastrados</div><div class="val">${S.produtos.length}</div><div class="sub">${new Set(S.produtos.map(p=>p.categoria)).size} categorias</div></div>
    <div class="kpi ${repoe.length?'alerta':'bom'}"><div class="rot">Abaixo do mínimo</div><div class="val">${repoe.length}</div><div class="sub">${repoe.length?'entram na lista de compras':'estoque saudável'}</div></div>
    <div class="kpi"><div class="rot">Saídas hoje</div><div class="val">${saidasHoje.length}</div><div class="sub">${num(saidasHoje.reduce((s,m)=>s+m.qtd,0))} itens</div></div>
    <div class="kpi bom"><div class="rot">Valor em estoque</div><div class="val" style="font-size:22px">${dinheiro(valor)}</div><div class="sub">${entradasHoje.length} entradas hoje</div></div>
  </div>

  ${S.inventario?`<div class="bloco"><h2>Inventário em andamento</h2><div class="corpo">
    <p style="margin-top:0">${esc(S.inventario.descricao)} — ${S.itensInv.filter(i=>i.contado!==null).length} de ${S.itensInv.length} itens contados.</p>
    <button class="btn" data-acao="ir" data-vista="inventario">Continuar contagem</button></div></div>`:''}

  <div class="bloco"><h2>Ações rápidas</h2><div class="corpo btn-linha">
    <button class="btn" data-acao="ir" data-vista="saida">Dar baixa em produto</button>
    <button class="btn sec" data-acao="ir" data-vista="entrada">Registrar entrada</button>
    <button class="btn sec" data-acao="ir" data-vista="relatorio">Fechar o dia</button>
    <button class="btn sec" data-acao="ir" data-vista="etiquetas">Imprimir etiquetas</button>
  </div></div>

  <div class="grade g2">
    <div class="bloco"><h2>Saídas dos últimos 7 dias</h2><div class="corpo">
      <div style="display:flex;align-items:flex-end;gap:6px;height:130px">
      ${serie.map((v,i)=>`<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:5px;height:100%">
        <div class="mono" style="font-size:10px;color:var(--mute)">${v||''}</div>
        <div style="width:100%;height:${Math.round(v/topo*88)}%;min-height:3px;background:${i===6?'var(--faixa)':'var(--tinta2)'};border-radius:1px"></div>
        <div class="mono" style="font-size:9px;color:var(--mute)">${dias[i].slice(8)}/${dias[i].slice(5,7)}</div></div>`).join('')}
      </div></div></div>

    <div class="bloco"><h2>Repor com prioridade <span class="conta">${repoe.length} itens</span></h2><div class="corpo rente">
      ${repoe.length?`<div class="rolagem"><table class="rr"><thead><tr><th>Produto</th><th class="n">Saldo</th><th class="n">Mín.</th><th class="n">Comprar</th></tr></thead><tbody>
      ${repoe.slice(0,8).map(p=>`<tr class="repor"><td><div class="nome-prod">${esc(p.nome)}</div><div class="sub-prod">${p.codigo} · ${esc(p.local)}</div></td>
      <td class="n" data-r="Saldo" style="color:var(--carimbo);font-weight:600">${num(p.estoque)}</td><td class="n" data-r="Mínimo">${num(p.minimo)}</td><td class="n" data-r="Comprar">${num(repor(p))} ${p.unidade}</td></tr>`).join('')}
      </tbody></table></div>`:'<div class="vazio"><b>Nada para repor</b>Todos os itens estão acima do mínimo.</div>'}
    </div></div>
  </div>

  <div class="bloco"><h2>Últimas movimentações</h2><div class="corpo rente">
    ${ult.length?`<div class="rolagem"><table class="rr"><thead><tr><th>Produto</th><th>Tipo</th><th class="n">Qtd.</th><th>Destino</th><th>Para quem</th></tr></thead>
    <tbody>${ult.map(linhaMov).join('')}</tbody></table></div>`
    :'<div class="vazio"><b>Nenhuma movimentação ainda</b>Comece dando baixa em um produto.</div>'}
  </div></div>`;
}
function linhaMov(m){
  return `<tr><td><div class="nome-prod">${esc(m.nome_produto)}</div>
  <div class="sub-prod">${esc(m.codigo)} · ${dataBR(diaDe(m.data))} ${horaBR(m.data)}</div></td>
  <td data-r="Tipo"><span class="chip ${m.tipo}">${m.tipo==='saida'?'Saída':m.tipo==='entrada'?'Entrada':'Ajuste'}</span></td>
  <td class="n" data-r="Quantidade">${m.tipo==='saida'?'−':'+'}${num(m.qtd)}</td>
  <td data-r="Destino">${esc(m.destino||'—')}</td><td data-r="Para quem">${esc(m.solicitante||'—')}</td></tr>`;
}

/* ===================================================================
   BAIXA / ENTRADA
   =================================================================== */
function vMovimento(tipo){
  const saida = tipo==='saida';
  return `<div class="bloco"><h2>${saida?'Baixa de produto':'Entrada de produto'}</h2><div class="corpo">
    <div class="leitor">
      <h3>${saida?'1. Leia o QR da prateleira':'1. Identifique o produto recebido'}</h3>
      <div class="campo-bip">
        <input id="campoBip" type="text" autocomplete="off" placeholder="Bipe o QR ou digite o código (ex.: ALM-0012)">
        <button class="btn" style="border-color:var(--faixa);background:var(--faixa);color:var(--tinta)" data-acao="buscar-cod">Abrir</button>
      </div>
      <div class="btn-linha" style="margin-top:10px">
        <button class="btn sec" style="color:#fff;border-color:#3A4A45" data-acao="camera">Ler com a câmera</button>
        <button class="btn sec" style="color:#fff;border-color:#3A4A45" data-acao="buscar-nome">Procurar pelo nome</button>
      </div>
      <div id="cam"></div>
      <div class="dica">Leitor USB, câmera do celular ou digitação — os três caem na mesma tela.</div>
    </div></div></div>
  ${selecionado? fichaMov(selecionado,tipo)
   : `<div class="bloco"><div class="vazio"><b>Nenhum produto na bancada</b>Leia uma etiqueta para abrir a ficha de ${saida?'saída':'entrada'}.</div></div>`}`;
}
function fichaMov(p, tipo){
  const saida = tipo==='saida', f = forn(p.fornecedor_id), baixo = abaixo(p);
  return `<div class="ficha" id="ficha"><div class="ficha-cab"></div><div class="ficha-in">
    <div class="ficha-tit"><h3>${esc(p.nome)}</h3><span class="cod">${p.codigo}</span>${baixo?'<span class="selo">Repor</span>':''}</div>
    <div class="meta"><span>Categoria <b>${esc(p.categoria)}</b></span><span>Local <b>${esc(p.local)}</b></span>
      <span>Unidade <b>${p.unidade}</b></span><span>Mínimo <b>${num(p.minimo)}</b></span>
      <span>Fornecedor <b>${esc(f?f.nome:'—')}</b></span></div>
    <div class="saldo ${baixo?'baixo':''}"><span class="u">Saldo atual</span><span class="n">${num(p.estoque)}</span><span class="u">${p.unidade}</span></div>
    <div style="margin-top:18px">
      <label class="campo"><span>${saida?'Quantidade que está saindo':'Quantidade recebida'}</span>
        <div class="qtd-ctrl"><button type="button" data-acao="qtd" data-passo="-1">−</button>
        <input id="fQtd" type="number" min="0.001" step="1" value="1">
        <button type="button" data-acao="qtd" data-passo="1">+</button></div></label>
      ${saida?`
      <div class="linha-campos c2">
        <label class="campo"><span>Para onde vai (destino)</span>
          <select id="fDestino">${S.setores.map(s=>`<option>${esc(s.nome)}</option>`).join('')}<option value="__outro">Outro local…</option></select></label>
        <label class="campo"><span>Para quem vai (solicitante)</span>
          <input id="fPessoa" type="text" list="listaPessoas" placeholder="Nome de quem retirou">
          <datalist id="listaPessoas">${S.pessoas.map(x=>`<option value="${esc(x)}">`).join('')}</datalist></label></div>
      <div class="linha-campos c2">
        <label class="campo"><span>Ordem de serviço / centro de custo</span><input id="fRef" type="text" placeholder="Ex.: OS-4471"></label>
        <label class="campo"><span>Responsável pela baixa</span><input id="fResp" type="text" value="${esc(perfil.nome)}"></label></div>`
      :`
      <div class="linha-campos c2">
        <label class="campo"><span>Fornecedor</span><select id="fFornEnt">${S.fornecedores.map(x=>`<option value="${x.id}" ${x.id===p.fornecedor_id?'selected':''}>${esc(x.nome)}</option>`).join('')}</select></label>
        <label class="campo"><span>Nota fiscal / pedido</span><input id="fRef" type="text" placeholder="Ex.: NF 10233"></label></div>
      <div class="linha-campos c2">
        <label class="campo"><span>Preço unitário</span><input id="fPreco" type="number" step="0.01" min="0" value="${p.preco}"></label>
        <label class="campo"><span>Responsável pelo recebimento</span><input id="fResp" type="text" value="${esc(perfil.nome)}"></label></div>`}
      <label class="campo"><span>Observação</span><textarea id="fObs" placeholder="Anotações sobre esta movimentação"></textarea></label>
      <div class="btn-linha">
        <button class="btn ${saida?'':'ok'} gr" style="flex:1;min-width:220px" data-acao="confirmar" data-tipo="${tipo}">${saida?'Confirmar saída':'Confirmar entrada'}</button>
        <button class="btn sec" data-acao="limpar-ficha">Cancelar</button></div>
    </div></div></div>`;
}

/* ===================================================================
   INVENTÁRIO
   =================================================================== */
function vInventario(){
  if(!S.inventario){
    return `<div class="bloco"><h2>Inventário</h2><div class="corpo">
      <p class="legenda" style="margin-top:0">A contagem congela o saldo do sistema no momento da abertura. Depois de contar, ao fechar, o sistema gera sozinho os movimentos de ajuste de cada divergência — nada é sobrescrito sem registro.</p>
      ${ehGestor()?`
      <div class="linha-campos c3">
        <label class="campo"><span>Descrição</span><input id="invDesc" type="text" placeholder="Ex.: Contagem de agosto"></label>
        <label class="campo"><span>Escopo</span><select id="invEscopo"><option value="total">Estoque inteiro</option><option value="categoria">Uma categoria</option><option value="local">Uma prateleira</option></select></label>
        <label class="campo"><span>Filtro (categoria ou prefixo do local)</span><input id="invFiltro" type="text" placeholder="Ex.: EPI ou B2"></label>
      </div>
      <button class="btn" data-acao="abrir-inventario">Abrir contagem</button>`
      :'<div class="vazio"><b>Nenhuma contagem aberta</b>Somente gestor ou admin pode abrir um inventário.</div>'}
    </div></div>`;
  }

  const contados = S.itensInv.filter(i=>i.contado!==null);
  const divergentes = contados.filter(i=>{ const p=porId(i.produto_id); return p && n(i.contado)!==n(p.estoque); });
  const valorDif = divergentes.reduce((s,i)=>{ const p=porId(i.produto_id); return s+(n(i.contado)-n(p.estoque))*p.preco; },0);
  const q = F.iBusca.trim().toLowerCase();
  const lista = S.itensInv.map(i=>({i, p:porId(i.produto_id)})).filter(({i,p})=>{
    if(!p) return false;
    if(F.iSoFalta && i.contado!==null) return false;
    if(!q) return true;
    return (p.nome+' '+p.codigo+' '+p.local).toLowerCase().includes(q);
  });

  return `
  <div class="bloco">
    <h2>${esc(S.inventario.descricao)} <span class="conta">aberto em ${dataBR(diaDe(S.inventario.criado_em))}</span></h2>
    <div class="corpo">
      <div class="kpis">
        <div class="kpi"><div class="rot">Itens na contagem</div><div class="val">${S.itensInv.length}</div><div class="sub">${esc(S.inventario.escopo)}${S.inventario.filtro?' · '+esc(S.inventario.filtro):''}</div></div>
        <div class="kpi bom"><div class="rot">Já contados</div><div class="val">${contados.length}</div><div class="sub">faltam ${S.itensInv.length-contados.length}</div></div>
        <div class="kpi ${divergentes.length?'alerta':'bom'}"><div class="rot">Divergências</div><div class="val">${divergentes.length}</div><div class="sub">viram ajuste ao fechar</div></div>
        <div class="kpi"><div class="rot">Impacto</div><div class="val" style="font-size:22px">${dinheiro(valorDif)}</div><div class="sub">diferença de valor</div></div>
      </div>
    </div>
    <div class="barra-filtros">
      <input id="iBusca" type="search" placeholder="Bipe o QR ou busque o item" value="${esc(F.iBusca)}" data-filtro-vivo="iBusca">
      <label class="chip" style="display:flex;align-items:center;gap:6px;padding:6px 12px;cursor:pointer"><input type="checkbox" style="width:auto" data-filtro="iSoFalta" ${F.iSoFalta?'checked':''}> Só o que falta contar</label>
      ${ehGestor()?`<button class="btn" data-acao="fechar-inventario">Fechar e gerar ajustes</button>
      <button class="btn sec" data-acao="cancelar-inventario">Cancelar contagem</button>`:''}
    </div>
    <div class="corpo rente">
      <div class="cont-linha" style="background:#F4F6F1;font-family:'Archivo';font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute)">
        <div class="cnome">Produto</div><div class="csaldo" style="text-align:right">Sistema</div><div class="ccontado" style="text-align:right">Contado</div><div class="cdif" style="text-align:right">Diferença</div>
      </div>
      ${lista.length? lista.map(({i,p})=>{
        const dif = i.contado===null? null : n(i.contado)-n(p.estoque);
        return `<div class="cont-linha">
          <div class="cnome"><div class="nome-prod">${esc(p.nome)}</div><div class="sub-prod">${p.codigo} · ${esc(p.local)} · ${p.unidade}</div></div>
          <div class="csaldo dif">${num(p.estoque)}</div>
          <div class="ccontado"><input type="number" step="0.001" min="0" value="${i.contado===null?'':i.contado}" data-contar="${i.id}" placeholder="—"></div>
          <div class="cdif dif ${dif===null?'':dif>0?'mais':dif<0?'menos':''}">${dif===null?'—':(dif>0?'+':'')+num(dif)}</div>
        </div>`;}).join('')
      : '<div class="vazio"><b>Nada nesta lista</b>Ajuste a busca ou o filtro acima.</div>'}
    </div>
  </div>`;
}

/* ===================================================================
   PRODUTOS
   =================================================================== */
const categorias = () => [...new Set(S.produtos.map(p=>p.categoria))].sort();
function filtrarProdutos(){
  const q=F.pBusca.trim().toLowerCase();
  return S.produtos.filter(p=>{
    if(F.pCat && p.categoria!==F.pCat) return false;
    if(F.pBaixo && !abaixo(p)) return false;
    return !q || (p.nome+' '+p.codigo+' '+p.local+' '+p.categoria).toLowerCase().includes(q);
  });
}
function vProdutos(){
  const lista = filtrarProdutos();
  return `<div class="bloco">
    <h2>Produtos <span class="conta">${lista.length} de ${S.produtos.length}</span></h2>
    <div class="barra-filtros">
      <input id="fBusca" type="search" placeholder="Buscar por nome, código ou prateleira" value="${esc(F.pBusca)}" data-filtro-vivo="pBusca">
      <select data-filtro="pCat"><option value="">Todas as categorias</option>${categorias().map(c=>`<option ${F.pCat===c?'selected':''}>${esc(c)}</option>`).join('')}</select>
      <label class="chip" style="display:flex;align-items:center;gap:6px;padding:6px 12px;cursor:pointer"><input type="checkbox" style="width:auto" data-filtro="pBaixo" ${F.pBaixo?'checked':''}> Só abaixo do mínimo</label>
    </div>
    ${ehGestor()?`<div class="corpo btn-linha" style="border-bottom:1px solid var(--linha)">
      <button class="btn" data-acao="novo-produto">Cadastrar produto</button>
      <button class="btn sec" data-acao="importar">Importar lista</button>
      <button class="btn sec" data-acao="exportar-produtos">Exportar CSV</button></div>`
      :`<div class="corpo btn-linha" style="border-bottom:1px solid var(--linha)"><button class="btn sec" data-acao="exportar-produtos">Exportar CSV</button></div>`}
    <div class="corpo rente">
      ${lista.length?`<div class="rolagem"><table class="rr">
      <thead><tr><th>Produto</th><th>Local</th><th class="n">Saldo</th><th class="n">Mín.</th><th class="n">Máx.</th><th>Fornecedor</th><th></th></tr></thead>
      <tbody>${lista.map(p=>`<tr class="${abaixo(p)?'repor':''}">
        <td><div class="nome-prod">${esc(p.nome)}</div><div class="sub-prod">${p.codigo} · ${esc(p.categoria)} · ${p.unidade} · ${dinheiro(p.preco)}</div></td>
        <td class="mono" data-r="Local" style="font-size:12px">${esc(p.local)}</td>
        <td class="n" data-r="Saldo" style="${abaixo(p)?'color:var(--carimbo);font-weight:600':''}">${num(p.estoque)}</td>
        <td class="n" data-r="Mínimo">${num(p.minimo)}</td><td class="n" data-r="Máximo">${num(p.maximo)}</td>
        <td data-r="Fornecedor" style="font-size:13px">${esc((forn(p.fornecedor_id)||{}).nome||'—')}</td>
        <td>${ehGestor()?`<button class="btn sec" style="padding:6px 10px" data-acao="editar-produto" data-id="${p.id}">Editar</button>`:''}</td>
      </tr>`).join('')}</tbody></table></div>`
      :'<div class="vazio"><b>Nenhum produto encontrado</b>Ajuste a busca acima.</div>'}
    </div></div>`;
}

/* ===================================================================
   ETIQUETAS
   =================================================================== */
function vEtiquetas(){
  const lista = S.produtos.filter(p=>!F.eCat || p.categoria===F.eCat);
  return `<div class="bloco">
    <h2>Etiquetas QR da prateleira <span class="conta" id="contaEtq">${etqSel.size} selecionadas</span></h2>
    <div class="barra-filtros">
      <select data-filtro="eCat"><option value="">Todas as categorias</option>${categorias().map(c=>`<option ${F.eCat===c?'selected':''}>${esc(c)}</option>`).join('')}</select>
      <button class="btn sec" data-acao="etq-todas">Marcar todas da lista</button>
      <button class="btn sec" data-acao="etq-nenhuma">Desmarcar</button>
      <button class="btn" data-acao="imprimir-etq" ${etqSel.size?'':'disabled'}>Imprimir ${etqSel.size||''} etiqueta${etqSel.size===1?'':'s'}</button>
    </div>
    <p class="legenda" style="padding:12px 16px 0;margin:0">Cada QR carrega o código do item. Cole na posição da prateleira: ao bipar, abre direto a ficha de baixa.</p>
    <div class="etq-grade">
      ${lista.map(p=>`<div class="etq"><div class="tarja"></div>
        <input class="sel" type="checkbox" data-acao="etq-marca" data-id="${p.id}" ${etqSel.has(p.id)?'checked':''} aria-label="Selecionar ${esc(p.nome)}">
        <div class="in"><div class="txt"><div class="c">${p.codigo}</div><div class="n">${esc(p.nome)}</div>
        <div class="l">${esc(p.local)} · ${p.unidade} · mín. ${num(p.minimo)}</div></div>
        <div class="qr" data-qr="${urlEtiqueta(p.codigo)}" data-tam="76"></div></div></div>`).join('')}
    </div></div>`;
}

/* ===================================================================
   MOVIMENTAÇÕES
   =================================================================== */
function filtrarMov(){
  return S.movimentos.filter(m=>{
    const d=diaDe(m.data);
    if(F.mDe && d<F.mDe) return false;
    if(F.mAte && d>F.mAte) return false;
    if(F.mTipo && m.tipo!==F.mTipo) return false;
    return true;
  });
}
function vMovimentos(){
  const lista = filtrarMov();
  return `<div class="bloco"><h2>Movimentações <span class="conta">${lista.length} registros</span></h2>
    <div class="barra-filtros">
      <label class="campo" style="margin:0"><span>De</span><input type="date" value="${F.mDe}" data-filtro="mDe"></label>
      <label class="campo" style="margin:0"><span>Até</span><input type="date" value="${F.mAte}" data-filtro="mAte"></label>
      <label class="campo" style="margin:0"><span>Tipo</span><select data-filtro="mTipo"><option value="">Todos</option>
        <option value="saida" ${F.mTipo==='saida'?'selected':''}>Saídas</option>
        <option value="entrada" ${F.mTipo==='entrada'?'selected':''}>Entradas</option></select></label>
      <button class="btn sec" style="align-self:flex-end" data-acao="exportar-mov">Exportar CSV</button>
    </div>
    <div class="corpo rente">
    ${lista.length?`<div class="rolagem"><table class="rr">
      <thead><tr><th>Produto</th><th>Tipo</th><th class="n">Qtd.</th><th class="n">Saldo</th><th>Destino</th><th>Para quem</th><th>Ref.</th><th>Responsável</th></tr></thead>
      <tbody>${lista.slice(0,400).map(m=>`<tr>
        <td><div class="nome-prod">${esc(m.nome_produto)}</div>
          <div class="sub-prod">${esc(m.codigo)} · ${dataBR(diaDe(m.data))} ${horaBR(m.data)}</div></td>
        <td data-r="Tipo"><span class="chip ${m.tipo}">${m.tipo==='saida'?'Saída':'Entrada'}</span></td>
        <td class="n" data-r="Quantidade">${m.tipo==='saida'?'−':'+'}${num(m.qtd)}</td>
        <td class="n" data-r="Saldo depois" style="color:var(--mute)">${num(m.saldo_depois)}</td>
        <td data-r="Destino">${esc(m.destino||'—')}</td><td data-r="Para quem">${esc(m.solicitante||'—')}</td>
        <td class="mono" data-r="Referência" style="font-size:12px">${esc(m.ref||'—')}</td>
        <td data-r="Responsável" style="font-size:13px">${esc(m.responsavel||'—')}</td></tr>`).join('')}
      </tbody></table></div>`
    :'<div class="vazio"><b>Sem movimentações no período</b>Altere as datas acima.</div>'}
    </div></div>`;
}

/* ===================================================================
   FECHAMENTO DO DIA
   =================================================================== */
function qtdCompra(p){
  const i = document.querySelector(`[data-compra="${p.id}"]`);
  return i ? n(i.value) : repor(p);
}
function vRelatorio(){
  const dia = F.rData || hoje();
  const doDia = S.movimentos.filter(m=>diaDe(m.data)===dia);
  const saidas = doDia.filter(m=>m.tipo==='saida'), entradas = doDia.filter(m=>m.tipo==='entrada');
  const valorSaida = saidas.reduce((s,m)=>s+m.qtd*m.preco,0);
  const porDestino = {}; saidas.forEach(m=>{ const k=m.destino||'Não informado'; (porDestino[k]=porDestino[k]||[]).push(m); });
  const compras = S.produtos.filter(abaixo);
  const porForn = {}; compras.forEach(p=>{ const k=p.fornecedor_id||'sem'; (porForn[k]=porForn[k]||[]).push(p); });
  const totalCompra = compras.reduce((s,p)=>s+repor(p)*p.preco,0);

  return `<div class="bloco"><h2>Fechamento do dia</h2>
    <div class="barra-filtros">
      <label class="campo" style="margin:0"><span>Data do relatório</span><input type="date" value="${dia}" data-filtro="rData"></label>
      <button class="btn sec" style="align-self:flex-end" data-acao="imprimir-relatorio">Imprimir relatório</button>
      <button class="btn sec" style="align-self:flex-end" data-acao="exportar-relatorio">Exportar CSV</button>
    </div>
    <div class="corpo"><div class="kpis">
      <div class="kpi"><div class="rot">Saídas</div><div class="val">${saidas.length}</div><div class="sub">${num(saidas.reduce((s,m)=>s+m.qtd,0))} itens</div></div>
      <div class="kpi"><div class="rot">Entradas</div><div class="val">${entradas.length}</div><div class="sub">${num(entradas.reduce((s,m)=>s+m.qtd,0))} itens</div></div>
      <div class="kpi"><div class="rot">Consumo estimado</div><div class="val" style="font-size:22px">${dinheiro(valorSaida)}</div><div class="sub">preço de cadastro</div></div>
      <div class="kpi ${compras.length?'alerta':'bom'}"><div class="rot">A comprar</div><div class="val">${compras.length}</div><div class="sub">${dinheiro(totalCompra)} estimados</div></div>
    </div></div></div>

  <div class="bloco"><h2>Saídas por destino — ${dataBR(dia)}</h2><div class="corpo rente">
    ${saidas.length? Object.entries(porDestino).map(([dest,ms])=>`
      <div style="padding:14px 16px;border-bottom:1px solid #EAEDE7">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <b class="disp" style="font-size:14px">${esc(dest)}</b><span class="chip">${ms.length} retirada${ms.length===1?'':'s'}</span></div>
        <table><tbody>${ms.map(m=>`<tr>
          <td style="padding-left:0"><div class="nome-prod">${esc(m.nome_produto)}</div>
          <div class="sub-prod">${esc(m.codigo)} · ${horaBR(m.data)} · ${esc(m.solicitante||'—')}</div></td>
          <td class="n" style="width:110px">${num(m.qtd)}</td></tr>`).join('')}</tbody></table>
      </div>`).join('')
    :'<div class="vazio"><b>Nenhuma saída neste dia</b>Escolha outra data acima.</div>'}
  </div></div>

  <div class="bloco"><h2>Sugestão de compras <span class="conta">${compras.length} itens · ${dinheiro(totalCompra)}</span></h2>
    <p class="legenda" style="padding:14px 16px 0;margin:0">Itens no mínimo ou abaixo. A sugestão recompõe o estoque até o máximo — ajuste antes de enviar para compras.</p>
    <div class="corpo rente">
    ${compras.length? Object.entries(porForn).map(([fid,ps])=>{
      const f = forn(fid), sub = ps.reduce((s,p)=>s+repor(p)*p.preco,0);
      return `<div style="padding:14px 16px;border-bottom:1px solid #EAEDE7">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px">
          <b class="disp" style="font-size:14px">${esc(f?f.nome:'Sem fornecedor definido')}</b>
          ${f?`<span class="sub-prod">${esc(f.contato)} · ${esc(f.fone)} · ${esc(f.email)}</span>`:''}
          <span class="chip" style="margin-left:auto">${dinheiro(sub)}</span></div>
        <div class="rolagem"><table class="rr"><thead><tr><th>Produto</th><th class="n">Saldo</th><th class="n">Mín/Máx</th><th class="n">Comprar</th><th class="n">Estimado</th></tr></thead>
        <tbody>${ps.map(p=>`<tr>
          <td><div class="nome-prod">${esc(p.nome)}</div><div class="sub-prod">${p.codigo} · ${esc(p.local)}</div></td>
          <td class="n" data-r="Saldo" style="color:var(--carimbo)">${num(p.estoque)}</td>
          <td class="n" data-r="Mín / Máx">${num(p.minimo)} / ${num(p.maximo)}</td>
          <td class="n" data-r="Comprar"><span><input type="number" min="0" step="1" value="${repor(p)}" data-compra="${p.id}" style="width:90px;text-align:right;padding:8px"> ${p.unidade}</span></td>
          <td class="n" data-r="Estimado"><span data-est="${p.id}">${dinheiro(repor(p)*p.preco)}</span></td></tr>`).join('')}</tbody></table></div>
      </div>`;}).join('')
    :'<div class="vazio"><b>Nenhuma compra necessária</b>Todos os itens estão acima do mínimo.</div>'}
    </div>
    ${compras.length?`<div class="corpo btn-linha" style="border-top:1px solid var(--linha)">
      <button class="btn" data-acao="imprimir-pedido">Gerar pedido de compra</button>
      <button class="btn sec" data-acao="exportar-compras">Exportar lista CSV</button></div>`:''}
  </div>`;
}

/* ===================================================================
   CADASTROS
   =================================================================== */
function vCadastros(){
  const g = ehGestor();
  return `<div class="grade g2">
    <div class="bloco"><h2>Fornecedores <span class="conta">${S.fornecedores.length}</span></h2>
      <ul class="lista-simples">${S.fornecedores.map(f=>`<li><div><div class="nome-prod">${esc(f.nome)}</div>
        <div class="sub-prod">${esc(f.contato||'—')} · ${esc(f.fone||'—')}</div></div>
        ${g?`<button class="x" data-acao="del-forn" data-id="${f.id}" aria-label="Remover">&times;</button>`:''}</li>`).join('')}</ul>
      ${g?`<div class="add-linha"><input id="novoForn" type="text" placeholder="Nome do fornecedor">
        <input id="novoFornFone" type="text" placeholder="Contato / telefone" style="flex:.8">
        <button class="btn" data-acao="add-forn">Incluir</button></div>`:''}
    </div>

    <div class="bloco"><h2>Destinos / setores <span class="conta">${S.setores.length}</span></h2>
      <ul class="lista-simples">${S.setores.map(s=>`<li>${esc(s.nome)}
        ${g?`<button class="x" data-acao="del-setor" data-id="${s.id}" aria-label="Remover">&times;</button>`:''}</li>`).join('')}</ul>
      ${g?`<div class="add-linha"><input id="novoSetor" type="text" placeholder="Ex.: Laboratório">
        <button class="btn" data-acao="add-setor">Incluir</button></div>`:''}
    </div>

    <div class="bloco"><h2>Equipe <span class="conta" id="contaEquipe">—</span></h2>
      <div id="listaEquipe" class="sincro">Carregando…</div>
    </div>

    ${g?`<div class="bloco"><h2>Liberar novo acesso</h2>
      <p class="legenda" style="padding:14px 16px 0;margin:0">Ninguém entra sozinho. Você libera o usuário aqui, passa o nome de usuário para a pessoa, e ela define a própria senha na tela de acesso.</p>
      <div id="listaConvites" class="sincro">Carregando…</div>
      <div class="add-linha" style="flex-wrap:wrap">
        <input id="cvUsuario" type="text" placeholder="usuário (sem espaços)" style="min-width:140px">
        <input id="cvNome" type="text" placeholder="Nome da pessoa" style="min-width:140px">
        <select id="cvPapel" style="width:auto"><option value="almoxarife">almoxarife</option><option value="gestor">gestor</option><option value="admin">admin</option></select>
        <button class="btn" data-acao="criar-convite">Liberar</button>
      </div>
    </div>`:''}

    <div class="bloco"><h2>Sua conta</h2><div class="corpo">
      <div class="meta"><span>Nome <b>${esc(perfil.nome)}</b></span><span>Papel <b>${esc(perfil.papel)}</b></span>
        <span>Celular <b>${esc(perfil.telefone||'—')}</b></span></div>
      <p class="legenda" style="margin-top:14px">Movimentações não podem ser editadas nem apagadas por ninguém — nem por administradores. Correções são feitas por inventário, que deixa o ajuste registrado.</p>
      <div class="btn-linha"><button class="btn sec" data-acao="exportar-tudo">Exportar backup completo</button>
      <button class="btn sec" data-acao="trocar-senha">Trocar senha</button></div>
    </div></div>
  </div>`;
}
async function carregarEquipe(){
  const alvo = el('listaEquipe'); if(!alvo) return;
  const { data, error } = await sb.from('alm_perfis').select('*').order('criado_em');
  if(error || !data){ alvo.textContent = 'Somente gestores veem a equipe completa.'; return; }
  el('contaEquipe').textContent = data.length;
  alvo.classList.remove('sincro');
  alvo.innerHTML = `<ul class="lista-simples">${data.map(u=>`<li>
    <div><div class="nome-prod">${esc(u.nome)}</div><div class="sub-prod">${esc(u.telefone||'—')} · ${u.ativo?'ativo':'desativado'}</div></div>
    ${ehGestor()&&u.id!==perfil.id?`<select data-papel="${u.id}" style="width:auto;padding:5px;margin-left:auto">
      ${['almoxarife','gestor','admin'].map(p=>`<option ${u.papel===p?'selected':''}>${p}</option>`).join('')}</select>
      <button class="btn sec" style="padding:5px 9px" data-acao="alternar-ativo" data-id="${u.id}" data-ativo="${u.ativo}">${u.ativo?'Desativar':'Ativar'}</button>`
      :`<span class="papel" style="margin-left:auto">${esc(u.papel)}</span>`}</li>`).join('')}</ul>`;
  carregarConvites();
}
async function carregarConvites(){
  const alvo = el('listaConvites'); if(!alvo) return;
  const { data, error } = await sb.from('alm_convites').select('*').order('criado_em',{ascending:false});
  if(error){ alvo.textContent = erroBanco(error); return; }
  alvo.classList.remove('sincro');
  alvo.innerHTML = data.length ? `<ul class="lista-simples">${data.map(c=>`<li>
    <div><div class="nome-prod mono">${esc(c.usuario)}</div>
    <div class="sub-prod">${esc(c.nome||'—')} · ${esc(c.papel)} · ${c.usado_em?'já ativado':'aguardando a pessoa definir a senha'}</div></div>
    ${c.usado_em?'<span class="selo ok" style="margin-left:auto">Ativo</span>'
     :`<span class="selo neutro" style="margin-left:auto">Pendente</span>
       <button class="x" data-acao="del-convite" data-id="${c.id}" aria-label="Cancelar liberação">&times;</button>`}</li>`).join('')}</ul>`
    : '<div class="vazio" style="padding:20px"><b>Nenhum acesso liberado</b>Use o campo abaixo para liberar alguém.</div>';
}

/* ===================================================================
   LEITURA DE CÓDIGO
   =================================================================== */
function abrirProduto(entrada){
  const codigo = codigoDaLeitura(entrada);
  const p = acha(codigo);
  if(!p){ aviso('Código '+codigo+' não encontrado.','ruim'); buscarPorNome(codigo); return; }
  if(vista==='inventario'){ F.iBusca = p.codigo; render(); const c=document.querySelector(`[data-contar]`); if(c) c.focus(); return; }
  selecionado = p; render();
  setTimeout(()=>{ el('ficha')?.scrollIntoView({behavior:'smooth',block:'start'}); const q=el('fQtd'); if(q){q.focus();q.select();} },80);
}
function lerCampo(){
  const c = el('campoBip'); if(!c) return;
  const v = c.value.trim(); if(!v) return;
  c.value=''; abrirProduto(v);
}
async function pararCamera(){
  if(leitorCam){ try{ await leitorCam.stop(); leitorCam.clear(); }catch(e){} leitorCam=null; }
  const d = el('cam'); if(d) d.innerHTML='';
}
async function abrirCamera(){
  const div = el('cam'); if(!div) return;
  if(leitorCam){ await pararCamera(); return; }
  if(typeof Html5Qrcode==='undefined' || !navigator.mediaDevices){ aviso('Leitor de câmera indisponível neste navegador.','ruim'); return; }
  div.innerHTML='<div id="camBox"></div>';
  leitorCam = new Html5Qrcode('camBox');
  const aoLer = t => pararCamera().then(()=>abrirProduto(t));
  const cfg = {fps:10, qrbox:{width:220,height:220}};
  try{ await leitorCam.start({facingMode:{exact:'environment'}},cfg,aoLer,()=>{}); }
  catch(e1){
    try{ await leitorCam.start({facingMode:'environment'},cfg,aoLer,()=>{}); }
    catch(e2){
      try{ const cams = await Html5Qrcode.getCameras();
        if(!cams?.length) throw new Error('nenhuma câmera encontrada');
        await leitorCam.start(cams[cams.length-1].id,cfg,aoLer,()=>{});
      }catch(e3){ leitorCam=null; div.innerHTML='';
        aviso('Câmera bloqueada: '+(e3.message||e3)+'. Libere a permissão ou use o leitor USB.','ruim'); }
    }
  }
}
function buscarPorNome(termo=''){
  modal('Procurar produto',
   `<label class="campo"><span>Nome, código ou prateleira</span>
    <input id="buscaModal" type="search" value="${esc(termo)}" placeholder="Ex.: luva, cabo, ALM-0012"></label>
    <div id="resBusca" class="corpo rente"></div>`);
  const inp = el('buscaModal');
  const pinta = () => {
    const q = inp.value.trim().toLowerCase();
    const r = q ? S.produtos.filter(p=>(p.nome+' '+p.codigo+' '+p.local).toLowerCase().includes(q)).slice(0,25) : [];
    el('resBusca').innerHTML = r.length
      ? `<table><tbody>${r.map(p=>`<tr style="cursor:pointer" data-acao="sel-produto" data-id="${p.id}">
         <td><div class="nome-prod">${esc(p.nome)}</div><div class="sub-prod">${p.codigo} · ${esc(p.local)}</div></td>
         <td class="n">${num(p.estoque)} ${p.unidade}</td></tr>`).join('')}</tbody></table>`
      : (q?'<div class="vazio">Nada encontrado.</div>':'<p class="legenda">Digite para localizar o item.</p>');
  };
  inp.addEventListener('input',pinta); pinta(); inp.focus();
}

/* ===================================================================
   GRAVAÇÕES
   =================================================================== */
async function confirmar(tipo, botao){
  const p = selecionado; if(!p) return;
  const qtd = n(el('fQtd')?.value);
  if(!(qtd>0)){ aviso('Informe uma quantidade maior que zero.','ruim'); return; }
  const registro = { tipo, produto_id:p.id, qtd,
    ref: el('fRef')?.value.trim()||'', obs: el('fObs')?.value.trim()||'',
    responsavel: el('fResp')?.value.trim()||perfil.nome };

  if(tipo==='saida'){
    const destino = el('fDestino')?.value||'', pessoa = el('fPessoa')?.value.trim()||'';
    if(!destino || destino==='__outro'){ aviso('Informe para onde o material está indo.','ruim'); return; }
    if(!pessoa){ aviso('Informe para quem o material está sendo entregue.','ruim'); el('fPessoa').focus(); return; }
    if(qtd > p.estoque){ aviso(`Estoque insuficiente. Disponível: ${num(p.estoque)} ${p.unidade}.`,'ruim'); return; }
    Object.assign(registro, { destino, solicitante: pessoa });
    if(!S.setores.some(s=>s.nome===destino) && ehGestor()) await sb.from('alm_setores').insert({nome:destino});
  } else {
    const fid = el('fFornEnt')?.value, preco = n(el('fPreco')?.value);
    Object.assign(registro, { destino:(forn(fid)||{}).nome||'Recebimento', solicitante:'—', preco });
    if(fid && fid!==p.fornecedor_id && ehGestor()) await sb.from('alm_produtos').update({fornecedor_id:fid}).eq('id',p.id);
  }

  botao.disabled = true; botao.textContent = 'Gravando…';
  const { error } = await sb.from('alm_movimentos').insert(registro);
  botao.disabled = false;
  if(error){ aviso(erroBanco(error),'ruim'); render(); return; }

  await recarregar();
  const atual = porId(p.id);
  aviso(`${tipo==='saida'?'Saída':'Entrada'} registrada. Saldo de ${p.codigo}: ${num(atual.estoque)} ${atual.unidade}.`,'bom');
  if(tipo==='saida' && abaixo(atual)) setTimeout(()=>aviso(`${atual.nome} ficou no mínimo — entrou na lista de compras.`,'ruim'),500);
  selecionado = null; pintarAbas(); render();
}

function formProduto(id){
  const p = id ? porId(id) : {codigo:proximoCodigo(),nome:'',categoria:'',unidade:'UN',estoque:0,minimo:0,maximo:0,local:'',fornecedor_id:S.fornecedores[0]?.id,preco:0};
  const UNIDADES = ['UN','PAR','CX','PCT','M','BR','JG','GL','FD','RS','BB','RL','KG','L'];
  modal(id?'Editar produto':'Cadastrar produto',`
    <div class="linha-campos c2">
      <label class="campo"><span>Código (vira o QR)</span><input id="pCod" type="text" value="${esc(p.codigo)}"></label>
      <label class="campo"><span>Prateleira / posição</span><input id="pLocal" type="text" value="${esc(p.local)}" placeholder="Ex.: B2-04"></label></div>
    <label class="campo"><span>Nome do produto</span><input id="pNome" type="text" value="${esc(p.nome)}"></label>
    <div class="linha-campos c3">
      <label class="campo"><span>Categoria</span><input id="pCat" type="text" list="listaCat" value="${esc(p.categoria)}">
        <datalist id="listaCat">${categorias().map(c=>`<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="campo"><span>Unidade</span><select id="pUn">${UNIDADES.map(u=>`<option ${p.unidade===u?'selected':''}>${u}</option>`).join('')}</select></label>
      <label class="campo"><span>Preço unitário</span><input id="pPreco" type="number" step="0.01" min="0" value="${p.preco}"></label></div>
    <div class="linha-campos c3">
      <label class="campo"><span>Saldo ${id?'(só por movimento)':'inicial'}</span><input id="pEst" type="number" step="0.001" min="0" value="${p.estoque}" ${id?'disabled':''}></label>
      <label class="campo"><span>Estoque mínimo</span><input id="pMin" type="number" step="0.001" min="0" value="${p.minimo}"></label>
      <label class="campo"><span>Estoque máximo</span><input id="pMax" type="number" step="0.001" min="0" value="${p.maximo}"></label></div>
    <label class="campo"><span>Fornecedor</span><select id="pForn">${S.fornecedores.map(f=>`<option value="${f.id}" ${f.id===p.fornecedor_id?'selected':''}>${esc(f.nome)}</option>`).join('')}</select></label>
    ${id?'<p class="legenda">O saldo só muda por entrada, saída ou inventário — isso mantém o histórico fiel.</p>':''}`,
    `${id?`<button class="btn perigo" data-acao="excluir-produto" data-id="${id}">Desativar</button>`:''}
     <button class="btn sec" data-acao="fechar-modal">Cancelar</button>
     <button class="btn" data-acao="salvar-produto" data-id="${id||''}">Salvar produto</button>`);
}
function proximoCodigo(){
  const m = S.produtos.reduce((a,p)=>{const x=parseInt(String(p.codigo).replace(/\D/g,''),10); return isNaN(x)?a:Math.max(a,x);},0);
  return 'ALM-'+String(m+1).padStart(4,'0');
}
async function salvarProduto(id){
  const dados = {
    codigo: el('pCod').value.trim().toUpperCase(), nome: el('pNome').value.trim(),
    categoria: el('pCat').value.trim()||'Geral', unidade: el('pUn').value,
    minimo: n(el('pMin').value), maximo: n(el('pMax').value),
    local: el('pLocal').value.trim()||'—', fornecedor_id: el('pForn').value||null, preco: n(el('pPreco').value)
  };
  if(!dados.codigo || !dados.nome){ aviso('Código e nome são obrigatórios.','ruim'); return; }
  let erro;
  if(id){ ({error:erro} = await sb.from('alm_produtos').update(dados).eq('id',id)); }
  else { dados.estoque = n(el('pEst').value); ({error:erro} = await sb.from('alm_produtos').insert(dados)); }
  if(erro){ aviso(erroBanco(erro),'ruim'); return; }
  await recarregar(); fecharModal(); pintarAbas(); render();
  aviso('Produto salvo. Imprima a etiqueta na aba Etiquetas QR.','bom');
}

/* ---------------- importação ---------------- */
const semAcento = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
function telaImportar(){
  modal('Importar lista de produtos',`
   <p class="legenda">Cole a planilha ou envie um CSV. Colunas, nesta ordem ou com cabeçalho:
   <b>codigo; nome; categoria; unidade; estoque; minimo; maximo; local; fornecedor; preco</b>.
   Códigos já existentes são atualizados — o saldo de quem já existe não é alterado.</p>
   <label class="campo"><span>Arquivo CSV</span><input id="impArq" type="file" accept=".csv,.txt,.tsv"></label>
   <label class="campo"><span>Ou cole aqui</span><textarea id="impTxt" style="min-height:150px;font-family:'IBM Plex Mono';font-size:12px"
     placeholder="ALM-0100;Cadeado 40mm;Ferramentas;UN;12;5;30;D4-13;Ferramentaria Silva;28,90"></textarea></label>`,
   `<button class="btn sec" data-acao="fechar-modal">Cancelar</button><button class="btn" data-acao="processar-import">Importar</button>`);
  el('impArq').addEventListener('change',ev=>{
    const f = ev.target.files[0]; if(!f) return;
    const r = new FileReader(); r.onload = () => el('impTxt').value = r.result; r.readAsText(f,'utf-8');
  });
}
async function processarImport(){
  const txt = el('impTxt').value.trim();
  if(!txt){ aviso('Cole os dados ou selecione um arquivo.','ruim'); return; }
  let linhas = parseCSV(txt);
  let mapa = {codigo:0,nome:1,categoria:2,unidade:3,estoque:4,minimo:5,maximo:6,local:7,fornecedor:8,preco:9};
  const prim = linhas[0].map(semAcento);
  if(prim.some(c=>['codigo','cod','nome','produto','descricao'].includes(c))){
    mapa = {}; prim.forEach((c,i)=>{
      if(['codigo','cod','sku'].includes(c)) mapa.codigo=i;
      else if(['nome','produto','descricao'].includes(c)) mapa.nome=i;
      else if(['categoria','grupo','familia'].includes(c)) mapa.categoria=i;
      else if(['unidade','un','um'].includes(c)) mapa.unidade=i;
      else if(['estoque','saldo','quantidade','qtd'].includes(c)) mapa.estoque=i;
      else if(['minimo','min','estoqueminimo'].includes(c)) mapa.minimo=i;
      else if(['maximo','max','estoquemaximo'].includes(c)) mapa.maximo=i;
      else if(['local','prateleira','endereco','posicao'].includes(c)) mapa.local=i;
      else if(['fornecedor','forn'].includes(c)) mapa.fornecedor=i;
      else if(['preco','valor','custo'].includes(c)) mapa.preco=i;
    });
    linhas = linhas.slice(1);
  }
  const v = (l,k) => mapa[k]!==undefined ? String(l[mapa[k]]??'').trim() : '';
  const n2 = s => Number(String(s).replace(/\./g,'').replace(',','.'))||0;

  const novosForn = [...new Set(linhas.map(l=>v(l,'fornecedor')).filter(x=>x &&
    !S.fornecedores.some(f=>semAcento(f.nome)===semAcento(x))))];
  if(novosForn.length){
    const { error } = await sb.from('alm_fornecedores').insert(novosForn.map(nome=>({nome})));
    if(error){ aviso(erroBanco(error),'ruim'); return; }
    await recarregar();
  }

  const registros = linhas.map(l=>{
    const cod = v(l,'codigo').toUpperCase(), nome = v(l,'nome');
    if(!cod && !nome) return null;
    const fn = v(l,'fornecedor');
    const f = fn ? S.fornecedores.find(x=>semAcento(x.nome)===semAcento(fn)) : null;
    const r = { codigo: cod||proximoCodigo(), nome: nome||cod, categoria: v(l,'categoria')||'Geral',
      unidade:(v(l,'unidade')||'UN').toUpperCase(), minimo:n2(v(l,'minimo')), maximo:n2(v(l,'maximo')),
      local: v(l,'local')||'—', preco: n2(v(l,'preco')), fornecedor_id: f?f.id:null };
    if(!r.maximo) r.maximo = Math.max(r.minimo*3, n2(v(l,'estoque')));
    if(!acha(r.codigo)) r.estoque = n2(v(l,'estoque'));
    return r;
  }).filter(Boolean);

  if(!registros.length){ aviso('Nenhuma linha válida encontrada.','ruim'); return; }
  const { error } = await sb.from('alm_produtos').upsert(registros,{onConflict:'codigo'});
  if(error){ aviso(erroBanco(error),'ruim'); return; }
  await recarregar(); fecharModal(); pintarAbas(); render();
  aviso(`Importação concluída: ${registros.length} linhas processadas.`,'bom');
}

/* ---------------- inventário ---------------- */
async function abrirInventario(){
  const { error } = await sb.rpc('alm_abrir_inventario',{
    p_descricao: el('invDesc').value.trim(), p_escopo: el('invEscopo').value, p_filtro: el('invFiltro').value.trim() });
  if(error){ aviso(erroBanco(error),'ruim'); return; }
  await recarregar(); pintarAbas(); render();
  aviso('Contagem aberta. O saldo do sistema ficou congelado para comparação.','bom');
}
async function contar(itemId, valor){
  const patch = valor===''? {contado:null, contado_em:null, contado_por:null}
                          : {contado:n(valor), contado_em:new Date().toISOString(), contado_por:perfil.id};
  const { error } = await sb.from('alm_inventario_itens').update(patch).eq('id',itemId);
  if(error){ aviso(erroBanco(error),'ruim'); return; }
  const it = S.itensInv.find(i=>i.id===itemId);
  if(it) it.contado = valor===''? null : n(valor);
}
async function fecharInventario(){
  const contados = S.itensInv.filter(i=>i.contado!==null).length;
  if(!confirm(`Fechar a contagem com ${contados} itens contados? As divergências viram movimentos de ajuste e não podem ser desfeitas.`)) return;
  const { data, error } = await sb.rpc('alm_fechar_inventario',{ p_inventario: S.inventario.id });
  if(error){ aviso(erroBanco(error),'ruim'); return; }
  const r = Array.isArray(data)?data[0]:data;
  await recarregar(); pintarAbas(); render();
  aviso(`Inventário fechado: ${r.itens} itens conferidos, ${r.ajustes} ajustes gerados (${dinheiro(r.diferenca_valor)}).`,'bom');
}
async function cancelarInventario(){
  if(!confirm('Cancelar a contagem em andamento? Nenhum ajuste será gerado.')) return;
  const { error } = await sb.from('alm_inventarios').update({status:'cancelado',fechado_em:new Date().toISOString()}).eq('id',S.inventario.id);
  if(error){ aviso(erroBanco(error),'ruim'); return; }
  await recarregar(); pintarAbas(); render(); aviso('Contagem cancelada.','bom');
}

/* ===================================================================
   IMPRESSÃO E EXPORTAÇÃO
   =================================================================== */
function imprimir(html, comQR){
  const a = el('areaImpressao'); a.innerHTML = html;
  if(comQR) a.querySelectorAll('[data-qr]').forEach(d=>gerarQR(d,d.dataset.qr,Number(d.dataset.tam||86)));
  setTimeout(()=>{ window.print(); setTimeout(()=>a.innerHTML='',600); },260);
}
function cabDoc(titulo, sub){
  return `<div class="doc-cab"><div><h1>${esc(titulo)}</h1><div class="sub-prod">${esc(CONFIG.EMPRESA)}</div></div>
   <div class="d">${esc(sub)}<br>Emitido em ${dataBR(hoje())} ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}<br>por ${esc(perfil.nome)}</div></div>`;
}
function imprimirEtiquetas(){
  const ps = S.produtos.filter(p=>etqSel.has(p.id));
  if(!ps.length){ aviso('Selecione ao menos uma etiqueta.','ruim'); return; }
  imprimir(`<div class="etq-grade">${ps.map(p=>`<div class="etq"><div class="tarja"></div><div class="in">
    <div class="txt"><div class="c">${p.codigo}</div><div class="n">${esc(p.nome)}</div>
    <div class="l">${esc(p.local)} · ${p.unidade} · mín. ${num(p.minimo)}</div></div>
    <div class="qr" data-qr="${urlEtiqueta(p.codigo)}" data-tam="86"></div></div></div>`).join('')}</div>`, true);
}
function imprimirRelatorio(){
  const dia = F.rData||hoje();
  const saidas = S.movimentos.filter(m=>m.tipo==='saida'&&diaDe(m.data)===dia);
  const entradas = S.movimentos.filter(m=>m.tipo==='entrada'&&diaDe(m.data)===dia);
  const compras = S.produtos.filter(abaixo);
  imprimir(`${cabDoc('Relatório diário de almoxarifado','Data de referência: '+dataBR(dia))}
   <div class="doc-sec"><h2>Saídas (${saidas.length})</h2>
   ${saidas.length?`<table><thead><tr><th>Hora</th><th>Código</th><th>Produto</th><th class="n">Qtd.</th><th>Destino</th><th>Retirado por</th><th>Ref.</th></tr></thead>
   <tbody>${saidas.map(m=>`<tr><td>${horaBR(m.data)}</td><td>${esc(m.codigo)}</td><td>${esc(m.nome_produto)}</td>
   <td class="n">${num(m.qtd)}</td><td>${esc(m.destino)}</td><td>${esc(m.solicitante)}</td><td>${esc(m.ref)}</td></tr>`).join('')}</tbody></table>`
   :'<p>Nenhuma saída registrada.</p>'}</div>
   <div class="doc-sec"><h2>Entradas (${entradas.length})</h2>
   ${entradas.length?`<table><thead><tr><th>Hora</th><th>Código</th><th>Produto</th><th class="n">Qtd.</th><th>Origem</th><th>NF</th></tr></thead>
   <tbody>${entradas.map(m=>`<tr><td>${horaBR(m.data)}</td><td>${esc(m.codigo)}</td><td>${esc(m.nome_produto)}</td>
   <td class="n">${num(m.qtd)}</td><td>${esc(m.destino)}</td><td>${esc(m.ref)}</td></tr>`).join('')}</tbody></table>`
   :'<p>Nenhuma entrada registrada.</p>'}</div>
   <div class="doc-sec"><h2>Itens abaixo do mínimo (${compras.length})</h2>
   ${compras.length?`<table><thead><tr><th>Produto</th><th>Local</th><th class="n">Saldo</th><th class="n">Mín.</th><th class="n">Sugestão</th><th>Fornecedor</th></tr></thead>
   <tbody>${compras.map(p=>`<tr><td>${p.codigo}</td><td>${esc(p.nome)}</td><td>${esc(p.local)}</td><td class="n">${num(p.estoque)}</td>
   <td class="n">${num(p.minimo)}</td><td class="n">${num(qtdCompra(p))} ${p.unidade}</td><td>${esc((forn(p.fornecedor_id)||{}).nome||'')}</td></tr>`).join('')}</tbody></table>`
   :'<p>Nenhum item em nível crítico.</p>'}</div>
   <div class="assina"><div>Responsável pelo almoxarifado</div><div>Conferido por</div></div>`);
}
function imprimirPedido(){
  const compras = S.produtos.filter(abaixo).filter(p=>qtdCompra(p)>0);
  if(!compras.length){ aviso('Não há itens para o pedido.','ruim'); return; }
  const g = {}; compras.forEach(p=>{ const k=p.fornecedor_id||'sem'; (g[k]=g[k]||[]).push(p); });
  imprimir(`${cabDoc('Pedido de compra — sugestão do almoxarifado','Referência: '+dataBR(F.rData||hoje()))}
   ${Object.entries(g).map(([fid,ps])=>{
     const f = forn(fid), tot = ps.reduce((s,p)=>s+qtdCompra(p)*p.preco,0);
     return `<div class="doc-sec"><h2>${esc(f?f.nome:'Fornecedor a definir')}</h2>
       ${f?`<p class="sub-prod">${esc(f.contato)} · ${esc(f.fone)} · ${esc(f.email)}</p>`:''}
       <table><thead><tr><th>Código</th><th>Produto</th><th class="n">Qtd.</th><th>Un.</th><th class="n">Preço ref.</th><th class="n">Total</th></tr></thead>
       <tbody>${ps.map(p=>`<tr><td>${p.codigo}</td><td>${esc(p.nome)}</td><td class="n">${num(qtdCompra(p))}</td><td>${p.unidade}</td>
       <td class="n">${dinheiro(p.preco)}</td><td class="n">${dinheiro(qtdCompra(p)*p.preco)}</td></tr>`).join('')}
       <tr><td colspan="5" class="n"><b>Total estimado</b></td><td class="n"><b>${dinheiro(tot)}</b></td></tr></tbody></table></div>`;
   }).join('')}
   <div class="assina"><div>Solicitante</div><div>Aprovação de compras</div></div>`);
}
function exportarProdutos(){
  const l = [csvLinha(['codigo','nome','categoria','unidade','estoque','minimo','maximo','local','fornecedor','preco'])];
  S.produtos.forEach(p=>l.push(csvLinha([p.codigo,p.nome,p.categoria,p.unidade,p.estoque,p.minimo,p.maximo,p.local,
    (forn(p.fornecedor_id)||{}).nome||'',String(p.preco).replace('.',',')])));
  baixarArquivo('produtos-almoxarifado.csv', l.join('\n'));
}
function exportarMov(){
  const l = [csvLinha(['data','hora','tipo','codigo','produto','quantidade','saldo_apos','destino','solicitante','referencia','responsavel','observacao'])];
  filtrarMov().forEach(m=>l.push(csvLinha([dataBR(diaDe(m.data)),horaBR(m.data),m.tipo,m.codigo,m.nome_produto,m.qtd,
    m.saldo_depois,m.destino,m.solicitante,m.ref,m.responsavel,m.obs])));
  baixarArquivo('movimentacoes.csv', l.join('\n'));
}
function exportarCompras(){
  const l = [csvLinha(['fornecedor','codigo','produto','unidade','saldo','minimo','maximo','comprar','preco_ref','total_estimado'])];
  S.produtos.filter(abaixo).forEach(p=>{ const q = qtdCompra(p);
    l.push(csvLinha([(forn(p.fornecedor_id)||{}).nome||'',p.codigo,p.nome,p.unidade,p.estoque,p.minimo,p.maximo,q,
      String(p.preco).replace('.',','),String((q*p.preco).toFixed(2)).replace('.',',')])); });
  baixarArquivo('sugestao-de-compras.csv', l.join('\n'));
}
function exportarRelatorio(){
  const dia = F.rData||hoje();
  const l = [csvLinha(['relatorio do dia',dataBR(dia)]),''];
  l.push(csvLinha(['hora','tipo','codigo','produto','quantidade','saldo_apos','destino','para quem','referencia','responsavel']));
  S.movimentos.filter(m=>diaDe(m.data)===dia).forEach(m=>l.push(csvLinha([horaBR(m.data),m.tipo,m.codigo,m.nome_produto,
    m.qtd,m.saldo_depois,m.destino,m.solicitante,m.ref,m.responsavel])));
  l.push(''); l.push(csvLinha(['sugestao de compras']));
  l.push(csvLinha(['fornecedor','codigo','produto','saldo','minimo','comprar','unidade','total estimado']));
  S.produtos.filter(abaixo).forEach(p=>{ const q = qtdCompra(p);
    l.push(csvLinha([(forn(p.fornecedor_id)||{}).nome||'',p.codigo,p.nome,p.estoque,p.minimo,q,p.unidade,
      String((q*p.preco).toFixed(2)).replace('.',',')])); });
  baixarArquivo('fechamento-'+dia+'.csv', l.join('\n'));
}
function exportarTudo(){
  baixarArquivo('backup-almoxarifado.json', JSON.stringify({
    gerado_em:new Date().toISOString(), por:perfil.nome,
    produtos:S.produtos, fornecedores:S.fornecedores, setores:S.setores, movimentos:S.movimentos
  },null,1), 'application/json');
}

/* ===================================================================
   EVENTOS
   =================================================================== */
document.addEventListener('click', async ev => {
  if(ev.target.classList?.contains('cortina')){ fecharModal(); return; }
  const alvo = ev.target.closest('[data-acao]'); if(!alvo) return;
  const a = alvo.dataset.acao, id = alvo.dataset.id;
  if(a==='login' || a==='modo-ativar' || a==='modo-entrar'){
    ev.preventDefault();
    if(a==='login') await enviarLogin(); else trocarModoLogin(a==='modo-ativar'?'ativar':'entrar');
    return;
  }
  try{
    switch(a){
      case 'ir': await ir(alvo.dataset.vista); break;
      case 'criar-convite': {
        const usuario = limparUsuario(el('cvUsuario').value);
        if(!usuario) return aviso('Informe o nome de usuário da pessoa.','ruim');
        const { error } = await sb.from('alm_convites').insert({usuario, nome: el('cvNome').value.trim(), papel: el('cvPapel').value});
        if(error) return aviso(erroBanco(error),'ruim');
        el('cvUsuario').value=''; el('cvNome').value='';
        carregarConvites();
        aviso(`Acesso liberado para "${usuario}". Passe esse usuário para a pessoa — ela define a senha na tela de acesso.`,'bom'); break; }
      case 'del-convite': {
        const { error } = await sb.from('alm_convites').delete().eq('id',id);
        if(error) return aviso(erroBanco(error),'ruim');
        carregarConvites(); break; }
      case 'fechar-modal': fecharModal(); break;
      case 'buscar-cod': lerCampo(); break;
      case 'camera': abrirCamera(); break;
      case 'buscar-nome': buscarPorNome(); break;
      case 'sel-produto': fecharModal(); abrirProduto(porId(id).codigo); break;
      case 'qtd': { const c = el('fQtd'); c.value = Math.max(1, n(c.value)+Number(alvo.dataset.passo)); break; }
      case 'confirmar': await confirmar(alvo.dataset.tipo, alvo); break;
      case 'limpar-ficha': selecionado = null; render(); break;
      case 'novo-produto': formProduto(null); break;
      case 'editar-produto': formProduto(id); break;
      case 'salvar-produto': await salvarProduto(alvo.dataset.id); break;
      case 'excluir-produto':
        if(confirm('Desativar este produto? Ele sai das listas, mas o histórico é preservado.')){
          const { error } = await sb.from('alm_produtos').update({ativo:false}).eq('id',id);
          if(error) return aviso(erroBanco(error),'ruim');
          await recarregar(); fecharModal(); pintarAbas(); render(); aviso('Produto desativado.','bom');
        } break;
      case 'importar': telaImportar(); break;
      case 'processar-import': await processarImport(); break;
      case 'abrir-inventario': await abrirInventario(); break;
      case 'fechar-inventario': await fecharInventario(); break;
      case 'cancelar-inventario': await cancelarInventario(); break;
      case 'exportar-produtos': exportarProdutos(); break;
      case 'exportar-mov': exportarMov(); break;
      case 'exportar-compras': exportarCompras(); break;
      case 'exportar-relatorio': exportarRelatorio(); break;
      case 'exportar-tudo': exportarTudo(); break;
      case 'imprimir-etq': imprimirEtiquetas(); break;
      case 'imprimir-relatorio': imprimirRelatorio(); break;
      case 'imprimir-pedido': imprimirPedido(); break;
      case 'etq-todas': S.produtos.filter(p=>!F.eCat||p.categoria===F.eCat).forEach(p=>etqSel.add(p.id)); render(); break;
      case 'etq-nenhuma': etqSel.clear(); render(); break;
      case 'add-forn': {
        const nome = el('novoForn').value.trim(); if(!nome) return aviso('Informe o nome do fornecedor.','ruim');
        const { error } = await sb.from('alm_fornecedores').insert({nome, contato:el('novoFornFone').value.trim(), fone:el('novoFornFone').value.trim()});
        if(error) return aviso(erroBanco(error),'ruim');
        await recarregar(); render(); carregarEquipe(); aviso('Fornecedor incluído.','bom'); break; }
      case 'del-forn': {
        const { error } = await sb.from('alm_fornecedores').delete().eq('id',id);
        if(error) return aviso(erroBanco(error),'ruim');
        await recarregar(); render(); carregarEquipe(); break; }
      case 'add-setor': {
        const nome = el('novoSetor').value.trim(); if(!nome) break;
        const { error } = await sb.from('alm_setores').insert({nome});
        if(error) return aviso(erroBanco(error),'ruim');
        await recarregar(); render(); carregarEquipe(); break; }
      case 'del-setor': {
        const { error } = await sb.from('alm_setores').delete().eq('id',id);
        if(error) return aviso(erroBanco(error),'ruim');
        await recarregar(); render(); carregarEquipe(); break; }
      case 'alternar-ativo': {
        const { error } = await sb.from('alm_perfis').update({ativo: alvo.dataset.ativo!=='true'}).eq('id',id);
        if(error) return aviso(erroBanco(error),'ruim');
        carregarEquipe(); break; }
      case 'trocar-senha': {
        const nova = prompt('Nova senha (mínimo 6 caracteres):');
        if(!nova) break;
        if(nova.length<6) return aviso('A senha precisa de pelo menos 6 caracteres.','ruim');
        const { error } = await sb.auth.updateUser({password:nova});
        aviso(error?erroBanco(error):'Senha alterada.', error?'ruim':'bom'); break; }
    }
  }catch(e){ aviso(erroBanco(e),'ruim'); }
});

document.addEventListener('change', async ev => {
  const t = ev.target;
  if(t.dataset.filtro){ F[t.dataset.filtro] = t.type==='checkbox'? t.checked : t.value;
    if(t.dataset.filtro==='eCat') etqSel.clear();
    render(); if(vista==='cadastros') carregarEquipe(); return; }
  if(t.dataset.acao==='etq-marca'){ t.checked?etqSel.add(t.dataset.id):etqSel.delete(t.dataset.id);
    el('contaEtq').textContent = etqSel.size+' selecionadas';
    document.querySelector('[data-acao="imprimir-etq"]').disabled = !etqSel.size; return; }
  if(t.dataset.contar!==undefined){ await contar(t.dataset.contar, t.value); render(); return; }
  if(t.dataset.papel){
    const { error } = await sb.from('alm_perfis').update({papel:t.value}).eq('id',t.dataset.papel);
    aviso(error?erroBanco(error):'Papel atualizado.', error?'ruim':'bom'); return; }
  if(t.id==='fDestino' && t.value==='__outro'){
    const l = t.closest('label');
    l.innerHTML = '<span>Para onde vai (destino)</span><input id="fDestino" type="text" placeholder="Digite o destino">';
    el('fDestino').focus(); return; }
});

document.addEventListener('input', ev => {
  const t = ev.target;
  if(t.dataset.filtroVivo){ F[t.dataset.filtroVivo] = t.value; const id = t.id;
    render(); const novo = el(id); if(novo){ novo.focus(); novo.setSelectionRange(novo.value.length,novo.value.length); } return; }
  if(t.dataset.compra){ const p = porId(t.dataset.compra);
    const c = document.querySelector(`[data-est="${p.id}"]`); if(c) c.textContent = dinheiro(n(t.value)*p.preco); }
});

document.addEventListener('keydown', ev => {
  if(ev.key==='Enter'){
    if(ev.target.id==='campoBip'){ ev.preventDefault(); lerCampo(); }
    else if(ev.target.closest('#login')){ ev.preventDefault(); enviarLogin(); }
  }
  if(ev.key==='Escape') fecharModal();
});

const renderOriginal = render;
render = function(){ renderOriginal(); if(vista==='cadastros') carregarEquipe(); };

/* ---------------- partida ---------------- */
(async () => {
  try{
    const { data:{ session } } = await sb.auth.getSession();
    if(session){ await entrarNoSistema(); }
    else { el('login').style.display='flex'; await montarLogin(); }
  }catch(e){
    el('login').style.display='flex';
    el('areaLogin').innerHTML = `<div class="erro-login">Falha ao iniciar: ${esc(e.message||e)}</div>
      <p class="legenda">Recarregue a página. Se persistir, confira a URL e a chave em assets/config.js.</p>`;
  }
})();
window.addEventListener('error', ev => {
  const area = el('areaLogin');
  if(area && el('login').style.display!=='none' && !el('btnLogin')){
    area.innerHTML = `<div class="erro-login">Erro de carregamento: ${esc(ev.message)}</div>`;
  }
});
