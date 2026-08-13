// Conexão com o Supabase — projeto cobreai-prod.
// A chave publicável é pública por natureza: quem protege os dados é a RLS do banco.
window.CONFIG = {
  SUPABASE_URL: 'https://ltizczxquvplietbtekv.supabase.co',
  SUPABASE_KEY: 'sb_publishable_RyLT9kcCqxN9dt2FrNXuZg_Exi2EY8s',
  // O login é por usuário + senha. O Supabase ancora cada conta num e-mail interno
  // montado a partir do usuário (ex.: estocado@almox.local). Esse endereço nunca
  // recebe mensagem; serve só como identificador da conta.
  DOMINIO_INTERNO: 'almox.local',
  // Endereço público do sistema. É o que vai dentro do QR das etiquetas:
  // apontar a câmera do celular abre direto a ficha de baixa do item.
  URL_BASE: 'https://estocado.vercel.app',
  EMPRESA: 'Estoque central'
};
