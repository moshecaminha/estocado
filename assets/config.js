// Conexão com o Supabase — projeto cobreai-prod.
// A chave publicável é pública por natureza: quem protege os dados é a RLS do banco.
window.CONFIG = {
  SUPABASE_URL: 'https://ltizczxquvplietbtekv.supabase.co',
  SUPABASE_KEY: 'sb_publishable_RyLT9kcCqxN9dt2FrNXuZg_Exi2EY8s',
  // O login é por celular + senha. O Supabase precisa de um e-mail interno para
  // ancorar a conta; o número vira um endereço técnico neste domínio, que nunca
  // recebe mensagem. Trocar por OTP real por SMS depois é mudar só o authTelefone().
  DOMINIO_INTERNO: 'almox.local',
  EMPRESA: 'Estoque central'
};
