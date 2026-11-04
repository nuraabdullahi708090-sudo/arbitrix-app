'use strict';

/**
 * Customer-facing copy for the Zernio WhatsApp automation (English and
 * Brazilian Portuguese).
 *
 * ONE SOURCE OF TRUTH: the same string feeds the approved Meta template and the
 * free-form reply inside the 24-hour service window, so an approved template
 * and an in-window answer can never drift apart.
 *
 * BRAZILIAN PORTUGUESE, not European Portuguese: "você", "conta", "saque",
 * "celular", "a gente" avoided in formal copy, no "estar a + infinitive", no
 * "utilizador", no "telemóvel". Dates and currency stay in the platform's
 * format ($100, 20%).
 *
 * BUSINESS FACTS PRESERVED VERBATIM IN BOTH LANGUAGES (do not edit one without
 * the other):
 *   - multi-asset automated arbitrage, not exclusively cryptocurrency
 *   - Demo Mode uses simulated funds
 *   - Live Mode requires a deposit
 *   - minimum deposit $100
 *   - $50 registration promotional credit, subject to eligibility and
 *     withdrawal conditions
 *   - referral reward: one-time 20% commission on a qualifying initial deposit
 *     of at least $100 (no recurring commission)
 *   - no guaranteed profits
 *   - trading involves risk
 *
 * The four official links are the only destinations used:
 *   https://arbitrix.pro
 *   https://arbitrix.pro/how-it-works
 *   https://arbitrix.pro/signup?ref=ARBI-YE9TUN
 *   https://arbitrix.pro/partners
 */

const LINKS = Object.freeze({
  website: 'https://arbitrix.pro',
  howItWorks: 'https://arbitrix.pro/how-it-works',
  signup: 'https://arbitrix.pro/signup?ref=ARBI-YE9TUN',
  partners: 'https://arbitrix.pro/partners'
});

const CONTENT = Object.freeze({
  en: Object.freeze({
    nameFallback: 'there',
    welcome: [
      'Hi {{1}}, welcome to Arbitrix!',
      '',
      'Arbitrix is an automated multi-asset arbitrage platform. It looks for price differences across markets and executes trades automatically - and it is not limited to cryptocurrency.',
      '',
      '- Demo Mode uses simulated funds, so you can see how it works before funding anything.',
      '- Live Mode requires a deposit, with a minimum of $100.',
      '- New accounts can receive a $50 promotional credit, subject to eligibility and withdrawal conditions.',
      '',
      'See how it works: ' + LINKS.howItWorks,
      'Create your account: ' + LINKS.signup,
      '',
      'Reply LANGUAGE at any time to switch between English and Portuguese.',
      '',
      'Trading involves risk and profits are not guaranteed. Reply STOP to opt out.'
    ].join('\n'),

    followup_6h: [
      'Hi {{1}}, a quick note from Arbitrix.',
      '',
      'The easiest way to see how multi-asset arbitrage works is Demo Mode. It uses simulated funds, so you can follow the bot and the results without depositing anything.',
      '',
      'When you are ready for real markets, Live Mode starts with a minimum deposit of $100.',
      '',
      'How it works: ' + LINKS.howItWorks,
      '',
      'Trading involves risk and profits are not guaranteed. Reply STOP to opt out.'
    ].join('\n'),

    followup_1d: [
      'Hi {{1}}, ready to try Arbitrix with real funds?',
      '',
      'Live Mode starts with a minimum deposit of $100. New accounts can also receive a $50 promotional credit for trading, subject to eligibility and withdrawal conditions.',
      '',
      'Registration takes a couple of minutes: ' + LINKS.signup,
      '',
      'Trading involves risk and profits are not guaranteed. Reply STOP to opt out.'
    ].join('\n'),

    followup_3d: [
      'Hi {{1}}, one last note from Arbitrix.',
      '',
      'If you would like to share Arbitrix, the referral programme pays a one-time 20% commission on a qualifying initial deposit of at least $100. It is a one-time reward - there is no recurring commission.',
      '',
      'Partner details: ' + LINKS.partners,
      '',
      'You can still start in Demo Mode with simulated funds, or fund a Live account with a minimum deposit of $100: ' + LINKS.signup,
      '',
      'Trading involves risk and profits are not guaranteed. Reply STOP to opt out.'
    ].join('\n'),

    languagePrompt: [
      'I can continue in English or in Brazilian Portuguese.',
      'Posso continuar em inglês ou em português do Brasil.',
      '',
      'Which do you prefer? / Qual você prefere?',
      '1 - English',
      '2 - Português (Brasil)'
    ].join('\n'),
    languageSet: 'Great - I will continue in English.',
    languageSetOther: 'Great - I will continue in Brazilian Portuguese.',
    languageUnsupported: 'Right now I can help in English or in Brazilian Portuguese. Which would you prefer? / No momento, posso ajudar em inglês ou em português do Brasil. Qual você prefere?',

    optOutAck: 'You have been unsubscribed and will not receive further promotional messages from Arbitrix. You can still message us here for support at any time. Reply START to receive updates again.',
    optInAck: 'You are subscribed again and may receive updates from Arbitrix. Reply STOP at any time to opt out.',

    textOnly: 'I can only read text messages. Could you type your question here?',

    humanHandoffAck: 'I have passed your message to our support team. A person will reply here as soon as possible. Your language preference has been saved.',

    greeting: 'Hi! How can I help you today?\n\nYou can ask about registration, Demo Mode, deposits, trading, the referral programme, or risk.',

    fallback: 'I want to make sure I answer correctly, so let me check that with our team. A person will reply here as soon as possible.\n\nYou can also ask me about registration, Demo Mode, deposits, trading, the referral programme, or risk.',

    registration: [
      'You can create an account here: ' + LINKS.signup,
      '',
      'Registration takes a couple of minutes. You can start in Demo Mode with simulated funds, and Live Mode requires a deposit with a minimum of $100.',
      '',
      'New accounts can receive a $50 promotional credit, subject to eligibility and withdrawal conditions.'
    ].join('\n'),

    demo: [
      'Demo Mode uses simulated funds. It lets you follow the automated arbitrage bot and see how trades are recorded without depositing real money.',
      '',
      'Two things to keep in mind: Demo Mode results are not real profits, and the simulated funds cannot be withdrawn. Live Mode requires a deposit with a minimum of $100.',
      '',
      'Trading involves risk and profits are not guaranteed.'
    ].join('\n'),

    deposit: [
      'Live Mode requires a deposit, and the minimum deposit is $100.',
      '',
      'Deposits are made in USDT on the TRON (TRC20) network. Inside your account, open Deposit and the platform generates a deposit address for you. Send only USDT on TRC20 to that address.',
      '',
      'New accounts can receive a $50 promotional credit, subject to eligibility and withdrawal conditions.'
    ].join('\n'),

    trading: [
      'Arbitrix is an automated multi-asset arbitrage platform. It looks for price differences across markets and executes trades automatically - it is not limited to cryptocurrency.',
      '',
      'Demo Mode uses simulated funds. Live Mode requires a deposit, with a minimum of $100.',
      '',
      'Trading involves risk and profits are not guaranteed.'
    ].join('\n'),

    referral: [
      'The referral programme pays a one-time 20% commission on a qualifying initial deposit of at least $100.',
      '',
      'It is a one-time reward: there is no recurring or lifetime commission. Partner details: ' + LINKS.partners
    ].join('\n'),

    risk: [
      'Trading involves risk and profits are not guaranteed. You can lose money.',
      '',
      'Please only use funds you can afford to lose, and treat any example result as an illustration rather than a promise. Arbitrix does not guarantee returns.'
    ].join('\n')
  }),

  'pt-BR': Object.freeze({
    nameFallback: 'tudo bem',
    welcome: [
      'Olá, {{1}}! Boas-vindas à Arbitrix!',
      '',
      'A Arbitrix é uma plataforma de arbitragem automatizada multi-ativos. Ela identifica diferenças de preço entre mercados e executa as operações automaticamente - e não se limita a criptomoedas.',
      '',
      '- O Modo Demo usa fundos simulados, então você pode ver como funciona antes de depositar.',
      '- O Modo Live exige um depósito, com mínimo de $100.',
      '- Novas contas podem receber um crédito promocional de $50, sujeito à elegibilidade e às condições de saque.',
      '',
      'Veja como funciona: ' + LINKS.howItWorks,
      'Crie sua conta: ' + LINKS.signup,
      '',
      'Responda IDIOMA a qualquer momento para alternar entre inglês e português.',
      '',
      'Negociar envolve risco e os lucros não são garantidos. Responda PARAR para não receber mais mensagens.'
    ].join('\n'),

    followup_6h: [
      'Olá, {{1}}! Um recado rápido da Arbitrix.',
      '',
      'A forma mais fácil de ver como a arbitragem multi-ativos funciona é o Modo Demo. Ele usa fundos simulados, então você acompanha o robô e os resultados sem depositar nada.',
      '',
      'Quando quiser operar com mercados reais, o Modo Live começa com um depósito mínimo de $100.',
      '',
      'Como funciona: ' + LINKS.howItWorks,
      '',
      'Negociar envolve risco e os lucros não são garantidos. Responda PARAR para não receber mais mensagens.'
    ].join('\n'),

    followup_1d: [
      'Olá, {{1}}! Pronto para testar a Arbitrix com dinheiro real?',
      '',
      'O Modo Live começa com um depósito mínimo de $100. Novas contas também podem receber um crédito promocional de $50 para negociar, sujeito à elegibilidade e às condições de saque.',
      '',
      'O cadastro leva alguns minutos: ' + LINKS.signup,
      '',
      'Negociar envolve risco e os lucros não são garantidos. Responda PARAR para não receber mais mensagens.'
    ].join('\n'),

    followup_3d: [
      'Olá, {{1}}! Um último recado da Arbitrix.',
      '',
      'Se quiser indicar a Arbitrix, o programa de indicação paga uma comissão única de 20% sobre o primeiro depósito qualificado, de no mínimo $100. É um pagamento único - não existe comissão recorrente.',
      '',
      'Detalhes do parceiro: ' + LINKS.partners,
      '',
      'Você também pode começar no Modo Demo com fundos simulados, ou abrir uma conta Live com um depósito mínimo de $100: ' + LINKS.signup,
      '',
      'Negociar envolve risco e os lucros não são garantidos. Responda PARAR para não receber mais mensagens.'
    ].join('\n'),

    languagePrompt: [
      'Posso continuar em português do Brasil ou em inglês.',
      'I can continue in Brazilian Portuguese or in English.',
      '',
      'Qual você prefere? / Which do you prefer?',
      '1 - English',
      '2 - Português (Brasil)'
    ].join('\n'),

    textOnly: 'I can only read text messages. Could you type your question here?',

    languageSet: 'Perfeito - vou continuar em português do Brasil.',
    languageSetOther: 'Perfeito - vou continuar em inglês.',
    languageUnsupported: 'No momento, posso ajudar em português do Brasil ou em inglês. Qual você prefere? / Right now I can help in Brazilian Portuguese or in English. Which would you prefer?',

    optOutAck: 'Você foi descadastrado e não receberá mais mensagens promocionais da Arbitrix. Você ainda pode falar com a gente aqui para suporte a qualquer momento. Responda ATIVAR para voltar a receber as mensagens.',
    optInAck: 'Você voltou a receber mensagens da Arbitrix. Responda PARAR a qualquer momento para cancelar.',

    humanHandoffAck: 'Passei sua mensagem para a nossa equipe de suporte. Uma pessoa vai responder aqui o mais rápido possível. Sua preferência de idioma foi salva.',

    greeting: 'Olá! Como posso ajudar você hoje?\n\nVocê pode perguntar sobre cadastro, Modo Demo, depósito, negociação, programa de indicação ou risco.',

    fallback: 'Quero responder da forma correta, então vou confirmar isso com a nossa equipe. Uma pessoa vai responder aqui o mais rápido possível.\n\nVocê também pode perguntar sobre cadastro, Modo Demo, depósito, negociação, programa de indicação ou risco.',

    registration: [
      'Você pode criar sua conta aqui: ' + LINKS.signup,
      '',
      'O cadastro leva alguns minutos. Você pode começar no Modo Demo, com fundos simulados. O Modo Live exige um depósito, com mínimo de $100.',
      '',
      'Novas contas podem receber um crédito promocional de $50, sujeito à elegibilidade e às condições de saque.'
    ].join('\n'),

    demo: [
      'O Modo Demo usa fundos simulados. Ele permite acompanhar o robô de arbitragem automatizada e ver como as operações são registradas, sem depositar dinheiro real.',
      '',
      'Duas coisas importantes: os resultados do Modo Demo não são lucros reais, e os fundos simulados não podem ser sacados. O Modo Live exige um depósito, com mínimo de $100.',
      '',
      'Negociar envolve risco e os lucros não são garantidos.'
    ].join('\n'),

    deposit: [
      'O Modo Live exige um depósito, e o depósito mínimo é de $100.',
      '',
      'Os depósitos são feitos em USDT na rede TRON (TRC20). Dentro da sua conta, abra a área de Depósito e a plataforma gera um endereço para você. Envie somente USDT na rede TRC20 para esse endereço.',
      '',
      'Novas contas podem receber um crédito promocional de $50, sujeito à elegibilidade e às condições de saque.'
    ].join('\n'),

    trading: [
      'A Arbitrix é uma plataforma de arbitragem automatizada multi-ativos. Ela identifica diferenças de preço entre mercados e executa as operações automaticamente - não se limita a criptomoedas.',
      '',
      'O Modo Demo usa fundos simulados. O Modo Live exige um depósito, com mínimo de $100.',
      '',
      'Negociar envolve risco e os lucros não são garantidos.'
    ].join('\n'),

    referral: [
      'O programa de indicação paga uma comissão única de 20% sobre o primeiro depósito qualificado, de no mínimo $100.',
      '',
      'É um pagamento único: não existe comissão recorrente nem vitalícia. Detalhes do parceiro: ' + LINKS.partners
    ].join('\n'),

    risk: [
      'Negociar envolve risco e os lucros não são garantidos. Você pode perder dinheiro.',
      '',
      'Use apenas valores que você pode perder, e trate qualquer resultado de exemplo como ilustração, não como promessa. A Arbitrix não garante retornos.'
    ].join('\n')
  })
});

/**
 * Intent vocabulary. Kept next to the copy so a new topic is added in one place
 * and both languages are covered. Patterns are deliberately narrow: a false
 * positive here sends the wrong approved text.
 */
const INTENTS = Object.freeze({
  handoff: /\b(?:human|agent|person|representative|support\s+team|speak\s+to\s+someone|atendente|humano|pessoa|equipe|falar\s+com\s+algu[eé]m)\b/i,
  optOut: /^\s*(?:stop|unsubscribe|opt\s*out|parar|sair|descadastrar)\b[\s.!,]*$|^\s*(?:cancelar|remover)\s+(?:as\s+)?(?:mensagens|inscri[cç][aã]o|minha\s+inscri[cç][aã]o)[\s.!,]*$|^\s*n[aã]o\s+quero\s+(?:mais\s+)?receber[\s.!,]*$/i,
  optIn: /^\s*(?:start|subscribe|opt\s*in|ativar|voltar|inscrever)\b[\s.!,]*$|^\s*(?:sim,?\s*)?quero\s+(?:voltar\s+a\s+)?receber[\s.!,]*$/i,
  risk: /\b(?:risk|guarantee[ds]?|lose\s+money|loss|safe|risco|garantia|garantido|perder\s+dinheiro|perda|seguro)\b/i,
  referral: /\b(?:referrals?|refer|commissions?|partners?|indicar|indica[cç][aã]o|indica[cç][oõ]es|comiss[aã]o|comiss[oõ]es|parceiros?)\b/i,
  registration: /\b(?:register|registration|sign\s*up|create\s+(?:an\s+)?account|open\s+(?:an\s+)?account|cadastr(?:o|ar)|criar\s+conta|abrir\s+conta)\b/i,
  demo: /\b(?:demo|simulated|simulation|virtual|simulad[oa]s?|simula[cç][aã]o)\b/i,
  deposit: /\b(?:deposit|fund\s+(?:my\s+)?account|add\s+money|top\s+up|dep[oó]sito|depositar|adicionar\s+dinheiro|colocar\s+dinheiro|fundos)\b/i,
  trading: /\b(?:trade|trading|bot|arbitrage|negociar|negocia[cç][aã]o|rob[oô]|arbitragem)\b/i,
  greeting: /\b(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|ol[aá]|oi|bom\s+dia|boa\s+tarde|boa\s+noite)\b/i
});

const INTENT_KEYS = Object.freeze([
  'risk', 'referral', 'registration', 'demo', 'deposit', 'trading', 'greeting'
]);

/**
 * Pick the single best intent. `risk` wins over everything because a safety
 * question must never be answered with a sales message.
 */
function detectIntent(text) {
  const raw = String(text || '');
  for (const key of INTENT_KEYS) {
    if (INTENTS[key].test(raw)) return key;
  }
  return null;
}

function contentFor(language) {
  return CONTENT[language] || CONTENT.en;
}

function replyText(language, key) {
  const locale = contentFor(language);
  const value = locale[key];
  if (typeof value === 'string') return value;
  return LOCALE_FALLBACK(key);
}

function LOCALE_FALLBACK(key) {
  const value = CONTENT.en[key];
  return typeof value === 'string' ? value : '';
}

module.exports = {
  LINKS,
  CONTENT,
  INTENTS,
  contentFor,
  replyText,
  detectIntent
};
